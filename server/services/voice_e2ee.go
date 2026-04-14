// Package services — voice room E2EE passphrase management.
// SFrame passphrases are stored in-memory only and cleaned up when rooms empty
// out so a later session cannot decrypt recorded traffic (forward secrecy).
package services

import (
	cryptorand "crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"strings"
)

// getOrCreateRoomPassphrase returns or creates a per-room E2EE passphrase.
// 32 bytes crypto/rand -> base64. All participants in the room share the same passphrase.
func (s *voiceService) getOrCreateRoomPassphrase(roomName string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if passphrase, ok := s.roomPassphrases[roomName]; ok {
		return passphrase, nil
	}

	raw := make([]byte, 32)
	if _, err := cryptorand.Read(raw); err != nil {
		return "", fmt.Errorf("crypto/rand failed: %w", err)
	}
	passphrase := base64.RawURLEncoding.EncodeToString(raw)

	s.roomPassphrases[roomName] = passphrase
	log.Printf("[voice] created E2EE passphrase for room %s", roomName)
	return passphrase, nil
}

// cleanupRoomPassphraseIfEmpty deletes the passphrase when a room becomes empty (forward secrecy).
// MUST be called under mu.Lock (caller holds lock).
func (s *voiceService) cleanupRoomPassphraseIfEmpty(channelID string) {
	for _, state := range s.states {
		if state.ChannelID == channelID {
			return
		}
	}

	// Room empty — clean up all matching room names (format: "{serverID}:{channelID}")
	suffix := ":" + channelID
	for roomName := range s.roomPassphrases {
		if strings.HasSuffix(roomName, suffix) {
			delete(s.roomPassphrases, roomName)
			log.Printf("[voice] cleaned up E2EE passphrase for room %s", roomName)
		}
	}
}
