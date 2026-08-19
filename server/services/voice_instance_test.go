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
