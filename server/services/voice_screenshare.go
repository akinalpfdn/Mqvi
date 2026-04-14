// Package services — screen share viewer tracking.
// Server-side count of who is watching each streamer's screen; used to render
// viewer counts in the sidebar and for metrics.
package services

import (
	"github.com/akinalp/mqvi/ws"
)

func (s *voiceService) WatchScreenShare(viewerUserID, streamerUserID string, watching bool) {
	s.mu.Lock()

	// Verify streamer is actually in voice and streaming
	streamerState, ok := s.states[streamerUserID]
	if !ok || !streamerState.IsStreaming {
		s.mu.Unlock()
		return
	}

	if watching {
		if s.screenShareViewers[streamerUserID] == nil {
			s.screenShareViewers[streamerUserID] = make(map[string]bool)
		}
		s.screenShareViewers[streamerUserID][viewerUserID] = true
	} else {
		if viewers, exists := s.screenShareViewers[streamerUserID]; exists {
			delete(viewers, viewerUserID)
			if len(viewers) == 0 {
				delete(s.screenShareViewers, streamerUserID)
			}
		}
	}

	viewerCount := len(s.screenShareViewers[streamerUserID])
	channelID := streamerState.ChannelID
	serverID := streamerState.ServerID
	s.mu.Unlock()

	action := "leave"
	if watching {
		action = "join"
	}

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpScreenShareViewerUpdate,
		Data: ws.ScreenShareViewerUpdateData{
			StreamerUserID: streamerUserID,
			ChannelID:      channelID,
			ViewerCount:    viewerCount,
			ViewerUserID:   viewerUserID,
			Action:         action,
		},
	})
}

func (s *voiceService) GetScreenShareViewerCount(streamerUserID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.screenShareViewers[streamerUserID])
}

// GetScreenShareStats returns the total number of active streamers and total viewers.
func (s *voiceService) GetScreenShareStats() (streamers int, viewers int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, state := range s.states {
		if state.IsStreaming {
			streamers++
		}
	}
	for _, viewerSet := range s.screenShareViewers {
		viewers += len(viewerSet)
	}
	return
}

func (s *voiceService) CleanupViewersForStreamer(streamerUserID string) {
	s.mu.Lock()
	delete(s.screenShareViewers, streamerUserID)
	s.mu.Unlock()
}
