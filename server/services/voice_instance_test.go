package services

import "testing"

// The room name carries no instance identity, so two paths resolving different instances would each
// open a room of this same name on a different SFU — both working, neither hearing the other. These
// two helpers are the pair that prevents it, and they are only useful if everything uses them.

func TestGenerateRoomName_IsServerScoped(t *testing.T) {
	// Two servers may legitimately have a channel with the same id; the room must not collide.
	if a, b := generateRoomName("s1", "c1"), generateRoomName("s2", "c1"); a == b {
		t.Fatalf("same room name for different servers: %q", a)
	}
}

func TestGenerateRoomName_IsStable(t *testing.T) {
	// Every caller must produce the identical string — a join and a screen share that disagree by
	// one character are two rooms.
	if a, b := generateRoomName("s1", "c1"), generateRoomName("s1", "c1"); a != b {
		t.Fatalf("not stable: %q vs %q", a, b)
	}
	if got, want := generateRoomName("s1", "c1"), "s1:c1"; got != want {
		t.Errorf("got %q, want %q — the wire format changed, existing rooms will not match", got, want)
	}
}

func TestParseRoomName_InvertsGenerateRoomName(t *testing.T) {
	serverID, channelID, ok := ParseRoomName(generateRoomName("2556be2191737aa5", "f09d4499301a5686"))
	if !ok || serverID != "2556be2191737aa5" || channelID != "f09d4499301a5686" {
		t.Fatalf("round trip failed: %q %q %v", serverID, channelID, ok)
	}
	if _, _, ok := ParseRoomName(generateRoomName("default", "c1")); !ok {
		t.Fatal("the seeded server id \"default\" must parse")
	}
}

func TestParseRoomName_RejectsMalformed(t *testing.T) {
	for _, room := range []string{"", "abc", ":c1", "s1:", "a:b:c", ":"} {
		if _, _, ok := ParseRoomName(room); ok {
			t.Errorf("%q parsed; a room that is not serverID:channelID must be rejected, not guessed", room)
		}
	}
}

func TestSplitParticipantIdentity(t *testing.T) {
	tests := []struct {
		in, user string
		ss       bool
	}{
		{"u1", "u1", false},
		{"u1_ss", "u1", true},
		{"u1_ss_ss", "u1_ss", true}, // only the outer suffix is the sub-participant marker
	}
	for _, tt := range tests {
		user, ss := SplitParticipantIdentity(tt.in)
		if user != tt.user || ss != tt.ss {
			t.Errorf("%q: got (%q,%v) want (%q,%v)", tt.in, user, ss, tt.user, tt.ss)
		}
	}
}
