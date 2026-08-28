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
	// Follow the binding this channel already has, wherever it is recorded.
	if bound, found := s.boundInstance(ctx, channelID); found {
		creds, err := s.credentialsByID(ctx, bound)
		if err == nil {
			return creds, nil
		}
		// Only a *missing* instance justifies choosing again. Migration 090 says a channel bound to
		// an instance that no longer exists must rebind rather than fail, and it is reachable: an
		// admin deleting an instance cascades the row away while this process still holds the claim
		// in memory. But a transient database error must NOT rebind — releasing the binding of a
		// call that is still running is how the next joiner ends up in a same-named room on another
		// SFU, hearing nobody.
		if !errors.Is(err, pkg.ErrNotFound) {
			return nil, err
		}
		log.Printf("[voice] channel %s was bound to missing instance %s; rebinding", channelID, bound)
		s.mu.Lock()
		s.releaseChannelInstanceLocked(channelID)
		s.mu.Unlock()
	}

	// Unclaimed. Pick outside the lock — this is a DB call and the voice mutex guards a hot map.
	candidate, err := s.pickInstance(ctx, serverID)
	if err != nil {
		return nil, err
	}

	// Decrypt before claiming, not after. A claim written for credentials that then fail to decrypt
	// would leave the channel bound to something unusable, and the lookup above only rebinds when
	// the instance is *missing* — this one exists, so the channel would stay unjoinable for as long
	// as the claim lives. Not creating the state beats cleaning it up.
	creds, err := credentialsFrom(candidate, s.encryptionKey)
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
			return creds, nil
		}
		return s.credentialsByID(ctx, winner)
	}
	s.channelInstances[channelID] = candidate.ID
	s.mu.Unlock()

	s.persistBinding(ctx, channelID, candidate.ID)
	log.Printf("[voice] channel %s claimed livekit instance %s", channelID, candidate.ID)
	return creds, nil
}

// boundInstance reports the instance this channel is already bound to, memory first.
//
// The two sources used to be handled separately and drifted apart: the persisted one recovered from
// a dead instance and the in-memory one did not, so the same failure was survivable through one door
// and permanent through the other. One lookup, one recovery path.
//
// The memory hit must stay cheap — it is every join after the first — so the database is only
// consulted on a miss, which happens once per channel per process lifetime.
func (s *voiceService) boundInstance(ctx context.Context, channelID string) (string, bool) {
	s.mu.RLock()
	claimed, ok := s.channelInstances[channelID]
	s.mu.RUnlock()
	if ok {
		return claimed, true
	}

	// Nothing in memory. After a restart the process has forgotten the binding while the clients are
	// still connected to the SFU, and picking afresh would send the next joiner to a different
	// instance and split a live room. Persistence exists for this one case.
	stored, found := s.storedBinding(ctx, channelID)
	if !found {
		return "", false
	}
	return s.adoptBinding(channelID, stored), true
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
	// The query orders by region, it does not filter by it — deliberately, so a region with no
	// instance still yields somebody. That means "best" can be in a completely different region, and
	// moving the call there is only right if it is actually nearer. It is not: right after migration
	// 091 every instance reads as unknown, so the region term is 0 for all of them and the ordering
	// collapses to plain least-loaded. A German caller on a busy Nuremberg instance would be sent to
	// a fresh Ashburn box across the Atlantic — the exact opposite of the point — while the log
	// claimed it had placed them by region.
	if best.Region != region {
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
// Returns the instance the channel was released from, or "" if it was not bound. The caller needs
// it: the SFU teardown that follows has to talk to the instance the room actually lived on, and
// once the binding is gone nothing else can say which one that was. Guessing there means sending
// RemoveParticipant to a machine the participant was never on.
//
// MUST be called under mu.Lock, and only after confirming the channel is empty — the caller does
// that check because it shares it with the passphrase cleanup.
func (s *voiceService) releaseChannelInstanceLocked(channelID string) string {
	instanceID, ok := s.channelInstances[channelID]
	if !ok {
		// Nothing in memory, but the row can still be there: after a restart the clients re-assert
		// over the websocket without asking for a new token, so nothing ever adopted the binding
		// into this process. Left alone, the row outlives the call and the next session on that
		// channel adopts a placement made for people who are long gone.
		s.clearStoredBindingIfAny(channelID)
		return ""
	}
	delete(s.channelInstances, channelID)
	log.Printf("[voice] channel %s released livekit instance %s", channelID, instanceID)

	if s.bindingStore == nil {
		return instanceID
	}
	// Off the lock and off the caller's path: this runs inside the voice mutex, which must never
	// hold across I/O, and the room is already gone either way. Bounded so it cannot outlive a
	// shutdown. The delete names the instance so a late clear cannot erase a fresh claim.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// A new session may have claimed this channel while the clear was queued. Skip rather than
		// delete a row that now describes a call in progress.
		s.mu.RLock()
		_, reclaimed := s.channelInstances[channelID]
		s.mu.RUnlock()
		if reclaimed {
			return
		}
		// Named delete as well as the check above: the two cover different orderings, and the one
		// that matters is a re-claim landing on a *different* instance — that is the only case where
		// losing the row could put the next joiner in a same-named room on another SFU. A re-claim
		// onto the same instance can still lose its row in the gap between the check and the delete,
		// which is harmless: a restart there picks again under the same conditions and returns the
		// same instance.
		if err := s.bindingStore.ClearChannelBinding(ctx, channelID, instanceID); err != nil {
			log.Printf("[voice] failed to clear binding for channel %s: %v", channelID, err)
		}
	}()
	return instanceID
}

// boundRoomInstance resolves the instance a channel is ALREADY on, and never claims one.
//
// This is what every server-side LiveKit operation needs — removing a participant, listing a room,
// enforcing a mute. All of them act on a room that exists; none of them is a join. Routing them
// through the claiming resolver was a real bug: the teardown that runs when the last person leaves
// fires immediately after the binding is released, so it re-claimed the channel it had just freed,
// bound an empty channel to a region-blind pick, and then talked to that instance instead of the
// one the participant was actually on.
func (s *voiceService) boundRoomInstance(ctx context.Context, channelID string) (*roomCredentials, error) {
	bound, found := s.boundInstance(ctx, channelID)
	if !found {
		return nil, fmt.Errorf("%w: channel %s", errChannelNotBound, channelID)
	}
	return s.credentialsByID(ctx, bound)
}

// errChannelNotBound says no LiveKit room exists for this channel, which is a different answer from
// "the lookup failed" and callers must treat it differently.
//
// A room only comes into being when a token is minted and the channel claims an instance. A channel
// can hold voice state without that having happened: MoveUser rewrites state.ChannelID and hands
// out a force-move grant, leaving the target unbound until the moved client asks for its token, and
// the websocket join path never claims at all. Server-side operations that hit this must behave as
// they did before the binding existed — as if the room were simply empty — not fail. Failing meant
// the reconciliation sweep skipped the channel entirely and phantom participants were never reaped,
// which is the stale-timer bug that sweep was written to fix.
var errChannelNotBound = errors.New("channel is not bound to a livekit instance")

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

// pendingJoinTTL bounds how long a minted token keeps a channel "occupied" without a websocket
// join. It only has to cover the LiveKit handshake between the token response and the client's
// join, which is hundreds of milliseconds; a minute is generous and keeps a token that is never
// used from pinning a channel for longer than that.
const pendingJoinTTL = time.Minute

// markPendingJoin records that a token was issued for this channel and the join has not landed yet.
//
// The binding is claimed here, at token time, but everything that ends its life keys off s.states,
// which only exists once the websocket join arrives. That gap is what this closes.
func (s *voiceService) markPendingJoin(channelID, userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pendingJoins == nil {
		s.pendingJoins = make(map[string]map[string]time.Time)
	}
	if s.pendingJoins[channelID] == nil {
		s.pendingJoins[channelID] = make(map[string]time.Time)
	}
	s.pendingJoins[channelID][userID] = time.Now().Add(pendingJoinTTL)
}

// clearPendingJoinLocked drops the marker once the real voice state exists.
// MUST be called under mu.Lock.
func (s *voiceService) clearPendingJoinLocked(channelID, userID string) {
	pending, ok := s.pendingJoins[channelID]
	if !ok {
		return
	}
	delete(pending, userID)
	if len(pending) == 0 {
		delete(s.pendingJoins, channelID)
	}
}

// hasPendingJoinLocked reports whether anyone is still mid-handshake into this channel, pruning
// expired markers as it goes. MUST be called under mu.Lock.
func (s *voiceService) hasPendingJoinLocked(channelID string) bool {
	pending, ok := s.pendingJoins[channelID]
	if !ok {
		return false
	}
	now := time.Now()
	for userID, deadline := range pending {
		if now.After(deadline) {
			delete(pending, userID)
		}
	}
	if len(pending) == 0 {
		delete(s.pendingJoins, channelID)
		return false
	}
	return true
}

// sweepAbandonedBindingsLocked releases bindings for channels that have neither participants nor
// anyone still connecting.
//
// Needed because the ordinary release only fires when somebody leaves, and a channel that was
// claimed by a token nobody ever used has nobody to leave. Without this those bindings are
// permanent: the channel stays pinned to an instance picked for a person who never arrived, and
// migration 090's promise that the table holds only calls in progress is false.
//
// MUST be called under mu.Lock.
func (s *voiceService) sweepAbandonedBindingsLocked() {
	if len(s.channelInstances) == 0 {
		return
	}
	occupied := make(map[string]bool, len(s.states))
	for _, st := range s.states {
		occupied[st.ChannelID] = true
	}
	for channelID := range s.channelInstances {
		if occupied[channelID] || s.hasPendingJoinLocked(channelID) {
			continue
		}
		log.Printf("[voice] releasing abandoned binding for channel %s (no participants, nobody connecting)", channelID)
		s.releaseChannelInstanceLocked(channelID)
	}
}

// clearStoredBindingIfAny deletes a persisted binding this process never held in memory.
//
// Off the caller's path because it reads before it deletes and the caller holds the voice mutex.
// The read is what makes the delete conditional on the right instance, so a row written by a
// session that started in the meantime survives.
func (s *voiceService) clearStoredBindingIfAny(channelID string) {
	if s.bindingStore == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		stored, found := s.storedBinding(ctx, channelID)
		if !found {
			return
		}
		s.mu.RLock()
		_, reclaimed := s.channelInstances[channelID]
		s.mu.RUnlock()
		if reclaimed {
			return
		}
		if err := s.bindingStore.ClearChannelBinding(ctx, channelID, stored); err != nil {
			log.Printf("[voice] failed to clear orphaned binding for channel %s: %v", channelID, err)
		}
	}()
}
