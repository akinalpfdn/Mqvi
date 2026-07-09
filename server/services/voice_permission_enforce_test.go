package services

import (
	"testing"

	"github.com/akinalp/mqvi/models"
)

// S3 (Phase 46): a participant who loses ConnectVoice must be disconnected when the
// enforcement runs (channel-override path shown; server/user paths share the same core).
func TestEnforceChannelVoicePermissions_DisconnectsOnConnectVoiceLost(t *testing.T) {
	svc, _ := newTimerTestVoiceService(nil, 0) // resolver returns 0 perms → no ConnectVoice
	svc.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "ch1", ServerID: "srv1"}

	svc.EnforceChannelVoicePermissions("ch1")

	if svc.GetUserVoiceState("u1") != nil {
		t.Fatal("a participant that lost ConnectVoice must be disconnected")
	}
}

// A participant who retains ConnectVoice must NOT be disconnected (only their publish is
// re-asserted, which the honest client already mirrors).
func TestEnforceChannelVoicePermissions_KeepsUserWithConnectVoice(t *testing.T) {
	svc, _ := newTimerTestVoiceService(nil, models.PermConnectVoice) // has ConnectVoice, no Speak
	svc.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "ch1", ServerID: "srv1"}

	svc.EnforceChannelVoicePermissions("ch1")

	if svc.GetUserVoiceState("u1") == nil {
		t.Fatal("a participant that retains ConnectVoice must not be disconnected")
	}
}

// Only participants of the targeted channel are enforced — an unaffected channel's users
// stay, even when they'd fail the same permission check.
func TestEnforceChannelVoicePermissions_LeavesOtherChannelsAlone(t *testing.T) {
	svc, _ := newTimerTestVoiceService(nil, 0) // everyone would fail ConnectVoice
	svc.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "ch1", ServerID: "srv1"}
	svc.states["u2"] = &models.VoiceState{UserID: "u2", ChannelID: "ch2", ServerID: "srv1"}

	svc.EnforceChannelVoicePermissions("ch1")

	if svc.GetUserVoiceState("u1") != nil {
		t.Error("ch1 participant should be disconnected")
	}
	if svc.GetUserVoiceState("u2") == nil {
		t.Error("ch2 participant must be untouched by a ch1 enforcement")
	}
}

// The user-scoped entry point is a no-op when the user isn't in voice.
func TestEnforceUserVoicePermissions_NoopWhenNotInVoice(t *testing.T) {
	svc, broadcasts := newTimerTestVoiceService(nil, 0)

	svc.EnforceUserVoicePermissions("ghost")

	if len(*broadcasts) != 0 {
		t.Fatalf("no broadcasts expected for a user not in voice, got %d", len(*broadcasts))
	}
}

// The user-scoped entry point disconnects the one affected user.
func TestEnforceUserVoicePermissions_DisconnectsAffectedUser(t *testing.T) {
	svc, _ := newTimerTestVoiceService(nil, 0)
	svc.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "ch1", ServerID: "srv1"}

	svc.EnforceUserVoicePermissions("u1")

	if svc.GetUserVoiceState("u1") != nil {
		t.Fatal("the user that lost ConnectVoice must be disconnected")
	}
}

// Finding #1 fix: the enforce path must read the CURRENT server-mute flag right before the
// SFU write, not a value snapshotted at enumeration — otherwise a server-mute an admin
// applies mid-enforcement gets clobbered (re-asserting publish would re-open the mic).
func TestCurrentServerMuteState_ReadsLiveNotSnapshot(t *testing.T) {
	svc, _ := newTimerTestVoiceService(nil, 0)
	svc.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "ch1", ServerID: "srv1", IsServerMuted: true}

	muted, in := svc.currentServerMuteState("u1")
	if !in || !muted {
		t.Fatalf("expected in=true muted=true, got in=%v muted=%v", in, muted)
	}

	// Simulate a concurrent admin unmute landing after a stale snapshot was taken.
	svc.states["u1"].IsServerMuted = false
	muted, in = svc.currentServerMuteState("u1")
	if !in || muted {
		t.Fatalf("expected the live (updated) value muted=false, got in=%v muted=%v", in, muted)
	}

	// A user who left voice between snapshot and now must report not-in-voice (skip SFU).
	if _, in := svc.currentServerMuteState("ghost"); in {
		t.Fatal("a user not in voice must report stillInVoice=false")
	}
}
