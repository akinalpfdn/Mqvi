package services

import "testing"

// The room name carries no instance identity, so two paths resolving different instances would each
// open a room of this same name on a different SFU — both working, neither hearing the other.

func TestFixedRoomName_IsServerScoped(t *testing.T) {
	// Two servers may legitimately have a channel with the same id; the room must not collide.
	if a, b := fixedRoomName("s1", "c1"), fixedRoomName("s2", "c1"); a == b {
		t.Fatalf("same room name for different servers: %q", a)
	}
}

func TestFixedRoomName_KeepsTheWireFormat(t *testing.T) {
	// Every call that was never rotated is in a room of exactly this name.
	if got, want := fixedRoomName("s1", "c1"), "s1:c1"; got != want {
		t.Errorf("got %q, want %q — the wire format changed, existing rooms will not match", got, want)
	}
}

func TestRotatedRoomName_IsNewEveryTime(t *testing.T) {
	seen := map[string]bool{fixedRoomName("s1", "c1"): true}
	for range 100 {
		name := rotatedRoomName("s1", "c1")
		if seen[name] {
			t.Fatalf("%q came up twice — a token for one room would open another", name)
		}
		seen[name] = true
	}
}

func TestParseRoomName_ReadsFixedAndRotatedNames(t *testing.T) {
	for _, room := range []string{
		fixedRoomName("2556be2191737aa5", "f09d4499301a5686"),
		rotatedRoomName("2556be2191737aa5", "f09d4499301a5686"),
	} {
		serverID, channelID, ok := ParseRoomName(room)
		if !ok || serverID != "2556be2191737aa5" || channelID != "f09d4499301a5686" {
			t.Fatalf("%q: got %q %q %v", room, serverID, channelID, ok)
		}
	}
	if _, _, ok := ParseRoomName(fixedRoomName("default", "c1")); !ok {
		t.Fatal("the seeded server id \"default\" must parse")
	}
}

func TestParseRoomName_RejectsMalformed(t *testing.T) {
	for _, room := range []string{"", "abc", ":c1", "s1:", "s1::x", "s1:c1:", ":", "a:b:c:d"} {
		if _, _, ok := ParseRoomName(room); ok {
			t.Errorf("%q parsed; a room that is not serverID:channelID[:rotation] must be rejected, not guessed", room)
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
