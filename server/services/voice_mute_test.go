package services

import (
	"testing"

	livekit "github.com/livekit/protocol/livekit"
)

func containsSource(sources []livekit.TrackSource, target livekit.TrackSource) bool {
	for _, s := range sources {
		if s == target {
			return true
		}
	}
	return false
}

// S4 (Phase 45): server-mute is enforced at the SFU by revoking only the microphone
// publish source. buildServerMutePermission is the pure core of that enforcement.
func TestBuildServerMutePermission(t *testing.T) {
	// Muted speaker: mic excluded, other sources still publishable, subscribe stays on.
	p := buildServerMutePermission(true, true)
	if !p.CanSubscribe {
		t.Error("subscribe must stay enabled (server-deafen is client-side, not SFU-enforced)")
	}
	if !p.CanPublish {
		t.Error("a muted speaker keeps publish for non-mic sources")
	}
	if len(p.CanPublishSources) == 0 {
		t.Fatal("a muted speaker must get an explicit source allow-list")
	}
	if containsSource(p.CanPublishSources, livekit.TrackSource_MICROPHONE) {
		t.Error("microphone must NOT be publishable when server-muted")
	}
	if !containsSource(p.CanPublishSources, livekit.TrackSource_SCREEN_SHARE) {
		t.Error("screen share must stay publishable while server-muted (audio-only mute)")
	}

	// Unmuted speaker: source restriction cleared → all sources allowed again.
	p = buildServerMutePermission(false, true)
	if len(p.CanPublishSources) != 0 {
		t.Error("unmute must clear the source allow-list")
	}
	if !p.CanPublish {
		t.Error("an unmuted speaker can publish")
	}

	// Muted non-speaker: no publish at all, and NO source allow-list (which would
	// otherwise supersede CanPublish and grant camera/screen share — an escalation).
	p = buildServerMutePermission(true, false)
	if p.CanPublish {
		t.Error("a non-speaker must not be granted publish")
	}
	if len(p.CanPublishSources) != 0 {
		t.Error("a non-speaker must not get a source allow-list (would grant publish)")
	}

	// Unmuted non-speaker: still cannot publish.
	p = buildServerMutePermission(false, false)
	if p.CanPublish {
		t.Error("a non-speaker must not be granted publish on unmute")
	}
}
