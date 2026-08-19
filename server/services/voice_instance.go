package services

import (
	"context"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
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

	log.Printf("[voice] channel %s claimed livekit instance %s", channelID, candidate.ID)
	return credentialsFrom(candidate, s.encryptionKey)
}

// pickInstance chooses the instance for a channel that has none yet.
//
// Today it answers with the server's instance, which is what every channel used before the binding
// existed — so with a single platform instance this whole mechanism is invisible. GEO-05 replaces
// the body with a region-aware choice; nothing outside this function needs to know.
func (s *voiceService) pickInstance(ctx context.Context, serverID string) (*models.LiveKitInstance, error) {
	inst, err := s.livekitGetter.GetByServerID(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("livekit instance lookup for server %s: %w", serverID, err)
	}
	return inst, nil
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
	if instanceID, ok := s.channelInstances[channelID]; ok {
		delete(s.channelInstances, channelID)
		log.Printf("[voice] channel %s released livekit instance %s", channelID, instanceID)
	}
}

// generateRoomName is the one place a room is named. Kept beside the resolver because the two are
// a pair: the name says which room, the resolver says which server it lives on, and a room is only
// unambiguous when both agree.
func generateRoomName(serverID, channelID string) string {
	return serverID + ":" + channelID
}
