package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"
)

// mockLiveKitGetter returns error so removeParticipantFromLiveKit goroutine exits early.
type mockLiveKitGetter struct{}

func (m *mockLiveKitGetter) GetByServerID(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	return nil, fmt.Errorf("no livekit instance in test")
}

func newTestVoiceService() (VoiceService, *testutil.MockBroadcaster) {
	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockLiveKitGetter{},
		&testutil.MockChannelPermResolver{},
		hub,
		nil, // onlineChecker
		nil, // afkTimeoutGetter
		nil, // encryptionKey
		&testutil.MockFileURLSigner{},
	)
	return svc, hub
}

func TestVoiceJoinChannel(t *testing.T) {
	svc, hub := newTestVoiceService()

	var broadcasts []ws.Event
	hub.BroadcastToAllFn = func(event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify state
	state := svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("expected voice state for u1")
	}
	if state.ChannelID != "ch1" {
		t.Errorf("channelID = %q, want %q", state.ChannelID, "ch1")
	}
	if state.Username != "alice" {
		t.Errorf("username = %q, want %q", state.Username, "alice")
	}

	// Verify broadcast
	if len(broadcasts) != 1 {
		t.Fatalf("expected 1 broadcast, got %d", len(broadcasts))
	}
	if broadcasts[0].Op != ws.OpVoiceStateUpdate {
		t.Errorf("op = %q, want %q", broadcasts[0].Op, ws.OpVoiceStateUpdate)
	}
}

func TestVoiceJoinChannel_SwitchChannels(t *testing.T) {
	svc, hub := newTestVoiceService()

	var broadcasts []ws.Event
	hub.BroadcastToAllFn = func(event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	// Join ch1
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	// Switch to ch2
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false)

	state := svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("expected voice state")
	}
	if state.ChannelID != "ch2" {
		t.Errorf("channelID = %q, want %q", state.ChannelID, "ch2")
	}

	// Should have: join ch1, leave ch1, join ch2 = 3 broadcasts
	if len(broadcasts) != 3 {
		t.Fatalf("expected 3 broadcasts (join+leave+join), got %d", len(broadcasts))
	}
}

func TestVoiceJoinChannel_SameChannelRejoin(t *testing.T) {
	svc, hub := newTestVoiceService()

	var broadcasts []ws.Event
	hub.BroadcastToAllFn = func(event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	// Join ch1
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	broadcasts = nil // reset

	// Rejoin same channel (WS reconnect scenario)
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	// Should produce zero broadcasts — silent rejoin
	if len(broadcasts) != 0 {
		t.Fatalf("expected 0 broadcasts for same-channel rejoin, got %d", len(broadcasts))
	}

	// State should still exist
	state := svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("expected voice state after rejoin")
	}
	if state.ChannelID != "ch1" {
		t.Errorf("channelID = %q, want %q", state.ChannelID, "ch1")
	}
}

func TestVoiceLeaveChannel(t *testing.T) {
	svc, hub := newTestVoiceService()

	var broadcasts []ws.Event
	hub.BroadcastToAllFn = func(event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	broadcasts = nil // reset

	err := svc.LeaveChannel("u1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	state := svc.GetUserVoiceState("u1")
	if state != nil {
		t.Error("expected nil state after leave")
	}

	if len(broadcasts) < 1 {
		t.Fatal("expected at least 1 leave broadcast")
	}
}

func TestVoiceLeaveChannel_NotInVoice(t *testing.T) {
	svc, _ := newTestVoiceService()

	// Leave when not in voice should be a no-op
	err := svc.LeaveChannel("u1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVoiceUpdateState(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	truev := true
	falsev := false

	// Mute
	_ = svc.UpdateState("u1", &truev, nil, nil)
	state := svc.GetUserVoiceState("u1")
	if !state.IsMuted {
		t.Error("expected muted=true")
	}
	if state.IsDeafened {
		t.Error("expected deafened=false (unchanged)")
	}

	// Deafen
	_ = svc.UpdateState("u1", nil, &truev, nil)
	state = svc.GetUserVoiceState("u1")
	if !state.IsDeafened {
		t.Error("expected deafened=true")
	}

	// Unmute
	_ = svc.UpdateState("u1", &falsev, nil, nil)
	state = svc.GetUserVoiceState("u1")
	if state.IsMuted {
		t.Error("expected muted=false after unmute")
	}

	// Start streaming
	_ = svc.UpdateState("u1", nil, nil, &truev)
	state = svc.GetUserVoiceState("u1")
	if !state.IsStreaming {
		t.Error("expected streaming=true")
	}
}

func TestVoiceUpdateState_NotInVoice(t *testing.T) {
	svc, _ := newTestVoiceService()

	truev := true
	err := svc.UpdateState("u1", &truev, nil, nil)
	if err != nil {
		t.Fatalf("update state for non-voice user should be no-op, got: %v", err)
	}
}

func TestVoiceGetChannelParticipants(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	_ = svc.JoinChannel("u2", "bob", "Bob", "", "ch1", false, false)
	_ = svc.JoinChannel("u3", "charlie", "Charlie", "", "ch2", false, false)

	ch1Participants := svc.GetChannelParticipants("ch1")
	if len(ch1Participants) != 2 {
		t.Errorf("ch1 participants = %d, want 2", len(ch1Participants))
	}

	ch2Participants := svc.GetChannelParticipants("ch2")
	if len(ch2Participants) != 1 {
		t.Errorf("ch2 participants = %d, want 1", len(ch2Participants))
	}

	emptyParticipants := svc.GetChannelParticipants("ch99")
	if len(emptyParticipants) != 0 {
		t.Errorf("empty channel participants = %d, want 0", len(emptyParticipants))
	}
}

func TestVoiceGetAllVoiceStates(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	_ = svc.JoinChannel("u2", "bob", "Bob", "", "ch2", false, false)

	all := svc.GetAllVoiceStates()
	if len(all) != 2 {
		t.Errorf("all states = %d, want 2", len(all))
	}
}

func TestVoiceDisconnectUser(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	svc.DisconnectUser("u1")

	state := svc.GetUserVoiceState("u1")
	if state != nil {
		t.Error("expected nil state after disconnect")
	}
}

func TestVoiceGetStreamCount(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	_ = svc.JoinChannel("u2", "bob", "Bob", "", "ch1", false, false)

	if svc.GetStreamCount("ch1") != 0 {
		t.Error("expected 0 streams initially")
	}

	truev := true
	_ = svc.UpdateState("u1", nil, nil, &truev)

	if svc.GetStreamCount("ch1") != 1 {
		t.Errorf("stream count = %d, want 1", svc.GetStreamCount("ch1"))
	}

	_ = svc.UpdateState("u2", nil, nil, &truev)

	if svc.GetStreamCount("ch1") != 2 {
		t.Errorf("stream count = %d, want 2", svc.GetStreamCount("ch1"))
	}
}

func TestVoiceGetUserVoiceChannelID(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	// Not in voice
	if svc.GetUserVoiceChannelID("u1") != "" {
		t.Error("expected empty channel ID for non-voice user")
	}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	if svc.GetUserVoiceChannelID("u1") != "ch1" {
		t.Errorf("channel ID = %q, want %q", svc.GetUserVoiceChannelID("u1"), "ch1")
	}
}

func TestVoiceScreenShareViewerTracking(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("streamer", "alice", "Alice", "", "ch1", false, false)
	_ = svc.JoinChannel("viewer1", "bob", "Bob", "", "ch1", false, false)

	// Start streaming
	truev := true
	_ = svc.UpdateState("streamer", nil, nil, &truev)

	// Watch
	svc.WatchScreenShare("viewer1", "streamer", true)
	if svc.GetScreenShareViewerCount("streamer") != 1 {
		t.Errorf("viewer count = %d, want 1", svc.GetScreenShareViewerCount("streamer"))
	}

	// Stop watching
	svc.WatchScreenShare("viewer1", "streamer", false)
	if svc.GetScreenShareViewerCount("streamer") != 0 {
		t.Errorf("viewer count = %d, want 0", svc.GetScreenShareViewerCount("streamer"))
	}
}

func TestVoiceCleanupViewersForStreamer(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("streamer", "alice", "Alice", "", "ch1", false, false)
	truev := true
	_ = svc.UpdateState("streamer", nil, nil, &truev)

	svc.WatchScreenShare("v1", "streamer", true)
	svc.WatchScreenShare("v2", "streamer", true)

	if svc.GetScreenShareViewerCount("streamer") != 2 {
		t.Fatalf("expected 2 viewers, got %d", svc.GetScreenShareViewerCount("streamer"))
	}

	svc.CleanupViewersForStreamer("streamer")

	if svc.GetScreenShareViewerCount("streamer") != 0 {
		t.Errorf("expected 0 viewers after cleanup, got %d", svc.GetScreenShareViewerCount("streamer"))
	}
}

func TestVoiceState_ServerMuteDeafen(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	state := svc.GetUserVoiceState("u1")
	if state.IsServerMuted || state.IsServerDeafened {
		t.Error("expected no server mute/deafen initially")
	}

	// Simulate server mute via admin (through direct state)
	// AdminUpdateState needs permission resolver, so test the state value after join
	voiceStates := svc.GetAllVoiceStates()
	found := false
	for _, vs := range voiceStates {
		if vs.UserID == "u1" {
			found = true
			if vs.ChannelID != "ch1" {
				t.Errorf("channelID = %q, want ch1", vs.ChannelID)
			}
		}
	}
	if !found {
		t.Error("u1 not found in voice states")
	}
}
