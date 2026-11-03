// Package services — the LiveKit room name of a voice channel.
package services

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/pkg"
)

// roomNameFor is the one answer to "what is this channel's LiveKit room called". Every server path
// that names a room — the voice token, the screen-share token, removal, listing, mute enforcement —
// asks here; a static test keeps it that way. Two paths disagreeing would put people in two rooms
// that both work and never hear each other, with nothing reporting it.
//
// A channel is in the fixed room until a rotation (rotateRoom) moves it, and the rotated name is
// read back from the store after a restart. A store that cannot be read is an error, never a guess:
// guessing the fixed name for a rotated channel would send the caller into the room the intruder was
// removed from.
//
// Takes only roomNamesMu, never s.mu. A cache miss reads the store, so callers should not hold s.mu.
func (s *voiceService) roomNameFor(ctx context.Context, serverID, channelID string) (string, error) {
	s.roomNamesMu.Lock()
	name, ok := s.roomNames[channelID]
	s.roomNamesMu.Unlock()
	if ok {
		return name, nil
	}

	name = fixedRoomName(serverID, channelID)
	if s.roomNameStore != nil {
		stored, err := s.roomNameStore.GetChannelRoomName(ctx, channelID)
		switch {
		case err == nil:
			name = stored
		case errors.Is(err, pkg.ErrNotFound):
			// Never rotated.
		default:
			return "", fmt.Errorf("room name for channel %s: %w", channelID, err)
		}
	}

	s.roomNamesMu.Lock()
	defer s.roomNamesMu.Unlock()
	// A rotation that landed while the store was read is newer than what was read.
	if cached, ok := s.roomNames[channelID]; ok {
		return cached, nil
	}
	s.roomNames[channelID] = name
	return name, nil
}

// fixedRoomName is the room every channel is in until it is rotated.
func fixedRoomName(serverID, channelID string) string {
	return serverID + ":" + channelID
}

// rotatedRoomName is a new room for a channel: the fixed name and a random part no earlier token
// carries.
func rotatedRoomName(serverID, channelID string) string {
	return fixedRoomName(serverID, channelID) + ":" + strings.ToLower(rand.Text())
}

// ParseRoomName reads the server and channel back out of a room name, fixed or rotated. IDs are 16
// hex characters or the literal "default", so a name with an empty part or a fourth part is not one
// of ours and is rejected rather than guessed at.
func ParseRoomName(room string) (serverID, channelID string, ok bool) {
	parts := strings.Split(room, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return "", "", false
	}
	for _, part := range parts {
		if part == "" {
			return "", "", false
		}
	}
	return parts[0], parts[1], true
}
