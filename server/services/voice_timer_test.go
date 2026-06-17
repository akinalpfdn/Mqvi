package services

import (
	"context"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"
)

// mockOnlineChecker reports a fixed online set for orphan-sweep tests.
type mockOnlineChecker struct{ online []string }

func (m *mockOnlineChecker) GetOnlineUserIDs() []string { return m.online }

// newTimerTestVoiceService builds a voiceService with a configurable online set
// and permission result, capturing every BroadcastToServer event.
func newTimerTestVoiceService(online []string, perms models.Permission) (*voiceService, *[]ws.Event) {
	hub := &testutil.MockBroadcaster{}
	broadcasts := &[]ws.Event{}
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		*broadcasts = append(*broadcasts, event)
	}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockLiveKitGetter{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return perms, nil
			},
		},
		hub,
		&mockOnlineChecker{online: online},
		nil, // afkTimeoutGetter
		nil, // encryptionKey
		&testutil.MockFileURLSigner{},
	)
	return svc.(*voiceService), broadcasts
}

// countChannelTimerEvents counts timer start/stop events for a specific channel.
func countChannelTimerEvents(events []ws.Event, op, channelID string) int {
	n := 0
	for _, e := range events {
		if e.Op != op {
			continue
		}
		switch d := e.Data.(type) {
		case ws.VoiceChannelTimerStartData:
			if d.ChannelID == channelID {
				n++
			}
		case ws.VoiceChannelTimerStopData:
			if d.ChannelID == channelID {
				n++
			}
		}
	}
	return n
}

// firstTimerIndex returns the index of the first start/stop timer event for a
// channel, or -1.
func firstTimerIndex(events []ws.Event, op, channelID string) int {
	for i, e := range events {
		if e.Op != op {
			continue
		}
		switch d := e.Data.(type) {
		case ws.VoiceChannelTimerStartData:
			if d.ChannelID == channelID {
				return i
			}
		case ws.VoiceChannelTimerStopData:
			if d.ChannelID == channelID {
				return i
			}
		}
	}
	return -1
}

// firstStateUpdateIndex returns the index of the first voice_state_update for a
// channel + action, or -1.
func firstStateUpdateIndex(events []ws.Event, channelID, action string) int {
	for i, e := range events {
		if e.Op != ws.OpVoiceStateUpdate {
			continue
		}
		if d, ok := e.Data.(ws.VoiceStateUpdateBroadcast); ok && d.ChannelID == channelID && d.Action == action {
			return i
		}
	}
	return -1
}

// Orphan sweep must stop the channel timer when its reap empties the channel.
// Regression test for the stale-timer bug (channel showed a duration with no
// participants because the orphan sweep removed the state but not the timer).
func TestOrphanSweep_StopsTimerWhenChannelEmpties(t *testing.T) {
	svc, broadcasts := newTimerTestVoiceService(nil, 0) // u1 offline (empty online set)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("join: %v", err)
	}
	if got := countChannelTimerEvents(*broadcasts, ws.OpVoiceChannelTimerStart, "ch1"); got != 1 {
		t.Fatalf("expected 1 timer-start for ch1 on join, got %d", got)
	}

	// Force the user past the orphan grace and sweep.
	svc.offlineSince["u1"] = time.Now().Add(-2 * orphanGracePeriod)
	svc.sweepOrphanStates()

	if svc.GetUserVoiceState("u1") != nil {
		t.Fatal("expected u1 reaped by orphan sweep")
	}
	if got := countChannelTimerEvents(*broadcasts, ws.OpVoiceChannelTimerStop, "ch1"); got != 1 {
		t.Fatalf("expected 1 timer-stop for ch1 after orphan reap, got %d", got)
	}
}

// AdminDisconnectUser must stop the channel timer when it removes the last user.
func TestAdminDisconnectUser_StopsTimerWhenChannelEmpties(t *testing.T) {
	svc, broadcasts := newTimerTestVoiceService(nil, models.PermMoveMembers)

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	if err := svc.AdminDisconnectUser(context.Background(), "admin", "u1"); err != nil {
		t.Fatalf("admin disconnect: %v", err)
	}
	if svc.GetUserVoiceState("u1") != nil {
		t.Fatal("expected u1 disconnected")
	}
	if got := countChannelTimerEvents(*broadcasts, ws.OpVoiceChannelTimerStop, "ch1"); got != 1 {
		t.Fatalf("expected 1 timer-stop for ch1 after admin disconnect, got %d", got)
	}
}

// MoveUser must stop the source timer when the move empties it and start the
// target timer when the move fills a previously empty channel.
func TestMoveUser_TimerTransitions(t *testing.T) {
	svc, broadcasts := newTimerTestVoiceService(nil, models.PermConnectVoice)

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	if err := svc.MoveUser(context.Background(), "u1", "u1", "ch2"); err != nil {
		t.Fatalf("move: %v", err)
	}
	if got := countChannelTimerEvents(*broadcasts, ws.OpVoiceChannelTimerStop, "ch1"); got != 1 {
		t.Fatalf("expected ch1 timer-stop after move emptied it, got %d", got)
	}
	if got := countChannelTimerEvents(*broadcasts, ws.OpVoiceChannelTimerStart, "ch2"); got != 1 {
		t.Fatalf("expected ch2 timer-start after move filled it, got %d", got)
	}

	// Ordering: the state-update must precede the timer event for each channel,
	// matching the JoinChannel/LeaveChannel contract.
	if leave, stop := firstStateUpdateIndex(*broadcasts, "ch1", "leave"), firstTimerIndex(*broadcasts, ws.OpVoiceChannelTimerStop, "ch1"); leave < 0 || stop < 0 || leave > stop {
		t.Fatalf("expected ch1 leave (%d) before timer-stop (%d)", leave, stop)
	}
	if join, start := firstStateUpdateIndex(*broadcasts, "ch2", "join"), firstTimerIndex(*broadcasts, ws.OpVoiceChannelTimerStart, "ch2"); join < 0 || start < 0 || join > start {
		t.Fatalf("expected ch2 join (%d) before timer-start (%d)", join, start)
	}
}

// A same-channel rejoin (F5 / WS reconnect re-assert) must reset the LiveKit
// absence tracker — otherwise a stale timestamp shortens the reconcile grace and
// can reap a user who is actively re-establishing their SFU connection.
func TestSameChannelRejoin_ResetsLiveKitAbsenceTracker(t *testing.T) {
	svc, _ := newTimerTestVoiceService(nil, 0)

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	svc.livekitAbsentSince["u1"] = time.Now().Add(-time.Hour) // reconcile marked absent

	// Silent same-channel rejoin.
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	if _, tracked := svc.livekitAbsentSince["u1"]; tracked {
		t.Fatal("expected livekitAbsentSince cleared on same-channel rejoin")
	}
}

// A fresh join must reset the LiveKit absence tracker so a stale absence
// timestamp from a previous session can't shorten the reconcile grace.
func TestJoinChannel_ResetsLiveKitAbsenceTracker(t *testing.T) {
	svc, _ := newTimerTestVoiceService(nil, 0)

	svc.livekitAbsentSince["u1"] = time.Now().Add(-time.Hour) // stale from a prior session
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	if _, tracked := svc.livekitAbsentSince["u1"]; tracked {
		t.Fatal("expected livekitAbsentSince cleared on fresh join")
	}
}
