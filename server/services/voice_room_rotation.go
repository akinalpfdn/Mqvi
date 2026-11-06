// Package services — moving a channel to a new LiveKit room when someone is in it who may not be.
package services

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	livekit "github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// movedInAttribute marks a LiveKit participant whose token was minted on a force-move grant. It is
// signed into the token — clients cannot change their attributes, since no grant here gives them
// canUpdateOwnMetadata — and LiveKit copies it into every token it renews, so it outlives a restart
// that forgets VoiceState.MovedIn and the pending marker (see mayBeInRoom).
const movedInAttribute = "mqvi.moved_in"

// retiredRoomWatch is how long a room a channel left keeps being deleted. A token minted just
// before the rotation names the old room, its holder may connect up to pendingJoinTTL later, and
// the sweep that deletes the room again runs once per livekitReconcileInterval.
const retiredRoomWatch = pendingJoinTTL + livekitReconcileInterval

// retiredRoom is a room a channel left because someone was in it who may not be there.
type retiredRoom struct {
	channelID  string
	instanceID string
	until      time.Time
	deleted    bool // LiveKit has confirmed it gone at least once
}

// removeUnentitledParticipants handles the participants the sweep found in a room with no voice
// state there.
//
// Only someone who may not connect counts. Everyone else is left alone, because a participant
// without a voice state is also every legitimate user after a server restart — states live in
// memory and clients re-assert them only when their websocket returns, which on a backgrounded iOS
// app can be hours. Such a user could rejoin anyway, so their presence opens nothing.
//
// Removing someone who may not connect is not enough: LiveKit takes their token again at once and
// hands them a fresh one at every join. Their channel moves to a new room instead (rotateRoom), and
// every token they hold then names a room nobody is in. One rotation per channel, however many of
// them were found.
func (s *voiceService) removeUnentitledParticipants(participants []roomParticipant) {
	type intrusion struct {
		serverID   string
		room       roomRef
		identities []string
	}
	byChannel := make(map[string]*intrusion)
	var order []string
	for _, p := range participants {
		if s.mayBeInRoom(p.serverID, p.userID, p.channelID, p.movedIn) {
			continue
		}
		log.Printf("[voice] livekit reconcile: %s is in channel %s's room with no voice state and no connect permission", p.identity, p.channelID)
		in, ok := byChannel[p.channelID]
		if !ok {
			in = &intrusion{serverID: p.serverID, room: p.room}
			byChannel[p.channelID] = in
			order = append(order, p.channelID)
		}
		in.identities = append(in.identities, p.identity)
	}
	for _, channelID := range order {
		in := byChannel[channelID]
		s.rotateRoom(in.serverID, channelID, in.room, in.identities)
	}
}

// rotateRoom moves channelID out of room from, where intruders were found.
//
// The new name is stored before anything uses it, so a restart never sends anyone back to the old
// room. If it cannot be stored, the intruders are only removed — what happened before rotation
// existed — and the next sweep finds them again and retries. Then the old room is deleted: everyone
// in it is disconnected, legitimate clients rejoin with a fresh token that names the new room, and
// the intruders cannot get one.
func (s *voiceService) rotateRoom(serverID, channelID string, from roomRef, intruders []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	s.roomNamesMu.Lock()
	current := s.roomNames[channelID]
	s.roomNamesMu.Unlock()
	if current != from.name {
		// Only this sweep rotates, so the listing and the cache agree; if they ever do not, the
		// room listed is not the channel's room and moving the channel would be wrong.
		log.Printf("[voice] livekit room rotation: channel %s listed room %s but is in %s; not rotating", channelID, from.name, current)
		return
	}

	to := rotatedRoomName(serverID, channelID)
	if s.roomNameStore != nil {
		if err := s.roomNameStore.SetChannelRoomName(ctx, channelID, to); err != nil {
			log.Printf("[voice] livekit room rotation: channel %s new room not stored: %v", channelID, err)
			s.logError(models.LogCategoryVoice, nil, "livekit room rotation: new room name not stored; intruders only removed", map[string]string{
				"channel_id": channelID, "identities": strings.Join(intruders, ","), "error": err.Error(),
			})
			s.removeFromRoom(ctx, from, intruders)
			return
		}
	}

	s.roomNamesMu.Lock()
	s.roomNames[channelID] = to
	s.retiredRooms[from.name] = retiredRoom{channelID: channelID, instanceID: from.instanceID, until: time.Now().Add(retiredRoomWatch)}
	s.roomNamesMu.Unlock()
	s.mu.Lock()
	delete(s.roomPassphrases, from.name)
	s.mu.Unlock()

	log.Printf("[voice] livekit room rotation: channel %s moved from %s to %s (intruders: %s)", channelID, from.name, to, strings.Join(intruders, ","))
	s.logWarn(models.LogCategoryVoice, nil, "livekit room rotated: someone was in the room without the right to be there", map[string]string{
		"channel_id": channelID, "identities": strings.Join(intruders, ","), "from_room": from.name, "to_room": to,
	})

	if !s.deleteRetiredRoom(ctx, from.name) {
		// Until the room is gone, at least the intruders are not in it.
		s.removeFromRoom(ctx, from, intruders)
	}
}

// sweepRetiredRooms deletes the rooms channels left, again, until their watch is over and LiveKit
// has confirmed each one gone.
func (s *voiceService) sweepRetiredRooms() {
	now := time.Now()
	var due []string
	s.roomNamesMu.Lock()
	for name, r := range s.retiredRooms {
		if r.deleted && now.After(r.until) {
			delete(s.retiredRooms, name)
			continue
		}
		due = append(due, name)
	}
	s.roomNamesMu.Unlock()
	if len(due) == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, name := range due {
		s.deleteRetiredRoom(ctx, name)
	}
}

// deleteRetiredRoom deletes a retired room on the instance it was on. Reports whether the room is
// gone; a room LiveKit does not know is gone.
func (s *voiceService) deleteRetiredRoom(ctx context.Context, name string) bool {
	s.roomNamesMu.Lock()
	r, ok := s.retiredRooms[name]
	s.roomNamesMu.Unlock()
	if !ok {
		return true
	}

	creds, err := s.credentialsByID(ctx, r.instanceID)
	if errors.Is(err, pkg.ErrNotFound) {
		// The instance itself is gone, and its rooms with it.
		s.roomNamesMu.Lock()
		delete(s.retiredRooms, name)
		s.roomNamesMu.Unlock()
		return true
	}
	if err == nil {
		_, err = lksdk.NewRoomServiceClient(creds.URL, creds.APIKey, creds.APISecret).
			DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: name})
	}
	if err != nil && !isLiveKitNotFound(err) {
		log.Printf("[voice] livekit room rotation: delete room %s failed: %v", name, err)
		s.logError(models.LogCategoryVoice, nil, "livekit room rotation: retired room not deleted; retrying next sweep", map[string]string{
			"channel_id": r.channelID, "room": name, "error": err.Error(),
		})
		return false
	}

	s.roomNamesMu.Lock()
	if cur, ok := s.retiredRooms[name]; ok {
		cur.deleted = true
		s.retiredRooms[name] = cur
	}
	s.roomNamesMu.Unlock()
	return true
}

// removeFromRoom removes identities from one exact room, not from wherever the channel is now.
// Best effort, like every other removal. MUST NOT be called under s.mu.
func (s *voiceService) removeFromRoom(ctx context.Context, room roomRef, identities []string) {
	creds, err := s.credentialsByID(ctx, room.instanceID)
	if err != nil {
		log.Printf("[voice] livekit room rotation: no client for room %s: %v", room.name, err)
		return
	}
	client := lksdk.NewRoomServiceClient(creds.URL, creds.APIKey, creds.APISecret)
	for _, identity := range identities {
		_, err := client.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: room.name, Identity: identity})
		if err != nil && !isLiveKitNotFound(err) {
			log.Printf("[voice] livekit room rotation: remove %s from %s failed: %v", identity, room.name, err)
		}
	}
}

// isLiveKitNotFound matches LiveKit's "not found" answer, the same way the other removal paths do.
func isLiveKitNotFound(err error) bool {
	return strings.Contains(err.Error(), "not_found") || strings.Contains(err.Error(), "not found")
}
