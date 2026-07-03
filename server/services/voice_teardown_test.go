package services

import (
	"testing"

	"github.com/akinalp/mqvi/models"
)

// S2 (Phase 44): server-delete teardown enumerates voice participants by server.
func TestGetServerParticipants_FiltersByServer(t *testing.T) {
	svc, _ := newTimerTestVoiceService(nil, models.PermConnectVoice)
	svc.states = map[string]*models.VoiceState{
		"u1": {UserID: "u1", ChannelID: "c1", ServerID: "srv1"},
		"u2": {UserID: "u2", ChannelID: "c2", ServerID: "srv1"},
		"u3": {UserID: "u3", ChannelID: "c9", ServerID: "srv2"},
	}

	got := svc.GetServerParticipants("srv1")
	if len(got) != 2 {
		t.Fatalf("want 2 participants for srv1, got %d", len(got))
	}
	for _, p := range got {
		if p.ServerID != "srv1" {
			t.Fatalf("leaked a participant from another server: %+v", p)
		}
	}
}

type fakeServerDisconnector struct {
	participants []models.VoiceState
	disconnected []string
}

func (f *fakeServerDisconnector) GetServerParticipants(_ string) []models.VoiceState {
	return f.participants
}

func (f *fakeServerDisconnector) DisconnectUser(userID string) {
	f.disconnected = append(f.disconnected, userID)
}

// The shared teardown helper must disconnect every enumerated participant.
func TestDisconnectServerVoiceParticipants_DisconnectsAll(t *testing.T) {
	f := &fakeServerDisconnector{
		participants: []models.VoiceState{{UserID: "u1"}, {UserID: "u2"}, {UserID: "u3"}},
	}

	disconnectServerVoiceParticipants(f, "srv1")

	if len(f.disconnected) != 3 {
		t.Fatalf("want 3 disconnects, got %d (%v)", len(f.disconnected), f.disconnected)
	}
}

// A nil disconnector (defensive: unwired construction) must be a no-op, not a panic.
func TestDisconnectServerVoiceParticipants_NilIsNoop(t *testing.T) {
	disconnectServerVoiceParticipants(nil, "srv1")
}
