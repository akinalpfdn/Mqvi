package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
)

// roomCredentials — where a voice channel's LiveKit room lives, and how to sign for it.
// Credentials are decrypted; they must never be logged or returned to a client.
type roomCredentials struct {
	InstanceID string
	URL        string
	APIKey     string
	APISecret  string
}

// resolveRoomInstance is the single answer to "which LiveKit instance serves this channel's room".
//
// Every path that needs it goes through here — the join token, the screen-share sub-participant
// token, and the server-side room client used for participant removal, listing and mute
// enforcement. That is not tidiness. The room name is `serverID:channelID` (see generateRoomName)
// and carries no instance identity, so if two of those paths ever resolved differently they would
// each open a room of the same name on a different SFU. Both halves would work, neither would hear
// the other, and nothing would error. One function makes that disagreement impossible rather than
// merely unlikely.
//
// The channel — not the server — owns the instance. The first request for an empty channel claims
// one and every later request follows it, so a channel is always one room in one place.
//
// MUST NOT be called while holding s.mu — it does DB lookups.
func (s *voiceService) resolveRoomInstance(ctx context.Context, serverID, channelID string) (*roomCredentials, error) {
	// Already claimed: the common case, and the only one that must be cheap.
	s.mu.RLock()
	claimed, ok := s.channelInstances[channelID]
	s.mu.RUnlock()
	if ok {
		return s.credentialsByID(ctx, claimed)
	}

	// Nothing in memory. Before choosing, ask whether a call is already running here — after a
	// restart the process has forgotten the binding while the clients are still connected to the
	// SFU, and picking afresh would send the next joiner to a different instance and split a live
	// room. Persistence exists for this one case.
	if stored, found := s.storedBinding(ctx, channelID); found {
		adopted := s.adoptBinding(channelID, stored)
		creds, err := s.credentialsByID(ctx, adopted)
		if err == nil {
			return creds, nil
		}
		// The instance the row names is gone. Drop the stale binding and choose again rather than
		// refuse the join — a channel bound to nothing must not be unjoinable.
		log.Printf("[voice] channel %s was bound to unusable instance %s (%v); rebinding", channelID, adopted, err)
		s.mu.Lock()
		s.releaseChannelInstanceLocked(channelID)
		s.mu.Unlock()
	}

	// Unclaimed. Pick outside the lock — this is a DB call and the voice mutex guards a hot map.
	candidate, err := s.pickInstance(ctx, serverID)
	if err != nil {
		return nil, err
	}

	// Claim, unless someone claimed while we were picking. Tokens are minted from an HTTP handler
	// and `JoinChannel` only arrives later over the websocket, so at this moment neither request
	// can see the other in the voice state — this second check under the lock is the only thing
	// standing between two simultaneous joiners and two different rooms.
	s.mu.Lock()
	if winner, taken := s.channelInstances[channelID]; taken {
		s.mu.Unlock()
		if winner == candidate.ID {
			return credentialsFrom(candidate, s.encryptionKey)
		}
		return s.credentialsByID(ctx, winner)
	}
	s.channelInstances[channelID] = candidate.ID
	s.mu.Unlock()

	s.persistBinding(ctx, channelID, candidate.ID)
	log.Printf("[voice] channel %s claimed livekit instance %s", channelID, candidate.ID)
	return credentialsFrom(candidate, s.encryptionKey)
}

// pickInstance chooses the instance for a channel that has none yet.
//
// Only the first joiner reaches this — everyone after follows the binding — so one person's region
// places the call for the whole channel. That is why the region comes from the Cloudflare edge and
// not from anything the client can set, and why every uncertain case here falls back to the
// server's own instance: that is what every channel used before regions existed, so with a single
// platform instance the whole mechanism stays invisible.
func (s *voiceService) pickInstance(ctx context.Context, serverID string) (*models.LiveKitInstance, error) {
	inst, err := s.livekitGetter.GetByServerID(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("livekit instance lookup for server %s: %w", serverID, err)
	}

	// A self-hosted server owns its LiveKit. There is nothing to choose between, and moving such a
	// call onto platform hardware would be both wrong and a surprise to whoever runs it.
	if !inst.IsPlatformManaged {
		return inst, nil
	}

	region, _ := ctx.Value(ctxkeys.ClientRegion).(string)
	if region == models.RegionUnknown {
		// No signal — the header is missing, or the caller is a background sweep with no request
		// behind it. Either way this is the pre-region behaviour: the server's own instance.
		return inst, nil
	}

	best, err := s.livekitGetter.GetPlatformInstanceForRegion(ctx, region)
	if err != nil {
		// Never fail a join over placement. The server's instance always worked before regions
		// existed and still does.
		log.Printf("[voice] region-aware pick failed for %s (region %s), using the server default: %v", serverID, region, err)
		return inst, nil
	}
	if best.ID != inst.ID {
		log.Printf("[voice] server %s default is %s; placing this call on %s for region %s", serverID, inst.ID, best.ID, region)
	}
	return best, nil
}

// credentialsByID re-reads an instance the channel is already bound to.
//
// The binding stores an id rather than the decrypted credentials on purpose: a long-lived map of
// plaintext API secrets is a liability out of proportion to the round trip it saves, and an
// instance whose credentials are rotated would otherwise keep serving the old ones.
func (s *voiceService) credentialsByID(ctx context.Context, instanceID string) (*roomCredentials, error) {
	inst, err := s.livekitGetter.GetByID(ctx, instanceID)
	if err != nil {
		return nil, fmt.Errorf("livekit instance %s lookup: %w", instanceID, err)
	}
	return credentialsFrom(inst, s.encryptionKey)
}

func credentialsFrom(inst *models.LiveKitInstance, encryptionKey []byte) (*roomCredentials, error) {
	apiKey, err := crypto.Decrypt(inst.APIKey, encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("livekit api key decrypt (instance %s): %w", inst.ID, err)
	}
	apiSecret, err := crypto.Decrypt(inst.APISecret, encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("livekit api secret decrypt (instance %s): %w", inst.ID, err)
	}
	return &roomCredentials{
		InstanceID: inst.ID,
		URL:        inst.URL,
		APIKey:     apiKey,
		APISecret:  apiSecret,
	}, nil
}

// releaseChannelInstanceLocked drops the binding once the channel is empty, so the next session
// picks afresh instead of inheriting a choice made for people who have all left.
//
// MUST be called under mu.Lock, and only after confirming the channel is empty — the caller does
// that check because it shares it with the passphrase cleanup.
func (s *voiceService) releaseChannelInstanceLocked(channelID string) {
	instanceID, ok := s.channelInstances[channelID]
	if !ok {
		return
	}
	delete(s.channelInstances, channelID)
	log.Printf("[voice] channel %s released livekit instance %s", channelID, instanceID)

	if s.bindingStore == nil {
		return
	}
	// Off the lock and off the caller's path: this runs inside the voice mutex, which must never
	// hold across I/O, and the room is already gone either way. Bounded so it cannot outlive a
	// shutdown.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.bindingStore.ClearChannelBinding(ctx, channelID); err != nil {
			log.Printf("[voice] failed to clear binding for channel %s: %v", channelID, err)
		}
	}()
}

// storedBinding reads a persisted binding. A missing row is the normal state, not a problem.
func (s *voiceService) storedBinding(ctx context.Context, channelID string) (string, bool) {
	if s.bindingStore == nil {
		return "", false
	}
	instanceID, err := s.bindingStore.GetChannelBinding(ctx, channelID)
	if err != nil {
		if !errors.Is(err, pkg.ErrNotFound) {
			log.Printf("[voice] failed to read binding for channel %s: %v", channelID, err)
		}
		return "", false
	}
	return instanceID, true
}

// adoptBinding takes a persisted binding into memory, yielding to anyone who claimed first.
func (s *voiceService) adoptBinding(channelID, instanceID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if winner, taken := s.channelInstances[channelID]; taken {
		return winner
	}
	s.channelInstances[channelID] = instanceID
	return instanceID
}

// persistBinding records the claim so a restart can find it again.
//
// Best effort, and the trade is deliberate: a failed write leaves runtime behaviour completely
// correct — memory is authoritative while the process lives — and only degrades recovery if this
// exact process dies before the call ends. Failing the join instead would turn a database hiccup
// into people being unable to talk, which is the worse outcome.
func (s *voiceService) persistBinding(ctx context.Context, channelID, instanceID string) {
	if s.bindingStore == nil {
		return
	}
	if err := s.bindingStore.SetChannelBinding(ctx, channelID, instanceID); err != nil {
		log.Printf("[voice] failed to persist binding %s -> %s: %v", channelID, instanceID, err)
		if s.appLogger != nil {
			s.appLogger.Log(models.LogLevelWarn, models.LogCategoryVoice, nil, nil,
				"voice channel instance binding not persisted; a restart may split this call",
				map[string]string{"channel_id": channelID, "instance_id": instanceID, "error": err.Error()})
		}
	}
}

// generateRoomName is the one place a room is named. Kept beside the resolver because the two are
// a pair: the name says which room, the resolver says which server it lives on, and a room is only
// unambiguous when both agree.
func generateRoomName(serverID, channelID string) string {
	return serverID + ":" + channelID
}
