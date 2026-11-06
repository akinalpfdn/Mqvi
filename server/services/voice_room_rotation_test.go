package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/testutil"
)

// LiveKit cannot revoke a token and renews it at every join, so a removed user's token stops working
// only when the room it names is no longer the channel's room. These tests hold the room name to one
// source and the rotation to the failure table agreed for it.

// fakeRoomNames is the room-name store; a channel without a row was never rotated.
type fakeRoomNames struct {
	mu     sync.Mutex
	rows   map[string]string
	getErr error
	setErr error
	sets   int
	onGet  func() // runs inside a read, before it returns
}

func newFakeRoomNames() *fakeRoomNames { return &fakeRoomNames{rows: map[string]string{}} }

func (f *fakeRoomNames) GetChannelRoomName(_ context.Context, channelID string) (string, error) {
	f.mu.Lock()
	hook, getErr := f.onGet, f.getErr
	name, ok := f.rows[channelID]
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	if getErr != nil {
		return "", getErr
	}
	if !ok {
		return "", pkg.ErrNotFound
	}
	return name, nil
}

func (f *fakeRoomNames) SetChannelRoomName(_ context.Context, channelID, roomName string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.setErr != nil {
		return f.setErr
	}
	f.sets++
	f.rows[channelID] = roomName
	return nil
}

func (f *fakeRoomNames) row(channelID string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	name, ok := f.rows[channelID]
	return name, ok
}

func tokenRoom(t *testing.T, token string) string {
	t.Helper()
	v, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}
	_, claims, err := v.Verify("devsecret")
	if err != nil {
		t.Fatalf("verify token: %v", err)
	}
	return claims.Video.Room
}

// speakingMember may view, connect and speak in ch1; everyone else nothing.
func speakingMember() *testutil.MockChannelPermResolver {
	return &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, userID, _ string) (models.Permission, error) {
			if userID == "member" {
				return models.PermViewChannel | models.PermConnectVoice | models.PermSpeak, nil
			}
			return 0, nil
		},
	}
}

// ── One source, today's name until a rotation ───────────────────────────────────────────────────

// A channel that was never rotated is in exactly the room it is in today, on every path.
func TestRoomName_UnrotatedChannelKeepsTodaysNameEverywhere(t *testing.T) {
	s, sfu := intruderHarness(t, speakingMember())
	s.roomNameStore = newFakeRoomNames()
	ctx := context.Background()

	voice, err := s.GenerateToken(ctx, "member", "m", "", "ch1")
	if err != nil {
		t.Fatalf("voice token: %v", err)
	}
	share, err := s.GenerateScreenShareToken(ctx, "member", "m", "", "ch1")
	if err != nil {
		t.Fatalf("screen token: %v", err)
	}
	for what, tok := range map[string]string{"voice": voice.Token, "screen share": share.Token} {
		if got := tokenRoom(t, tok); got != "srv1:ch1" {
			t.Errorf("%s token names %q, want srv1:ch1", what, got)
		}
	}

	if _, err := s.listRoom(ctx, "srv1", "ch1"); err != nil {
		t.Fatalf("list: %v", err)
	}
	s.removeParticipantFromLiveKit("srv1", "ch1", "someone", "")
	s.enforceServerMicMuteAtSFU("srv1", "ch1", "member", true, true)

	want := []string{"ListParticipants srv1:ch1", "RemoveParticipant srv1:ch1", "UpdateParticipant srv1:ch1"}
	if got := sfu.callLog(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("LiveKit calls %v, want %v", got, want)
	}
}

// Only roomNameFor decides a room name. A grant or request naming a room any other way is a second
// source, and two sources are how a call splits.
func TestRoomName_OnlyOneFunctionNamesRooms(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	roomField := regexp.MustCompile(`\bRoom:\s+([A-Za-z_.]+)`)
	allowed := map[string]bool{"roomName": true, "room.name": true, "name": true}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		code := string(src)
		if f != "voice_room_name.go" && strings.Contains(code, "fixedRoomName(") {
			t.Errorf("%s calls fixedRoomName; only roomNameFor may", f)
		}
		if f != "voice_room_name.go" && f != "voice_room_rotation.go" && strings.Contains(code, "rotatedRoomName(") {
			t.Errorf("%s calls rotatedRoomName; only rotateRoom may", f)
		}
		for _, m := range roomField.FindAllStringSubmatch(code, -1) {
			if !allowed[m[1]] {
				t.Errorf("%s sets Room: %s — a room name not taken from roomNameFor or a listed room", f, m[1])
			}
		}
	}
}

// A store that cannot be read fails the join. Guessing today's name for a rotated channel would put
// the caller in the room the intruder was moved out of.
func TestRoomName_UnreadableStoreFailsTheToken(t *testing.T) {
	s, _ := intruderHarness(t, speakingMember())
	store := newFakeRoomNames()
	store.getErr = errors.New("database is locked")
	s.roomNameStore = store

	if resp, err := s.GenerateToken(context.Background(), "member", "m", "", "ch2"); err == nil {
		t.Fatalf("token issued for room %q although the room name could not be read", tokenRoom(t, resp.Token))
	}
	s.mu.Lock()
	pending := s.hasPendingJoinLocked("ch2")
	_, claimed := s.channelInstances["ch2"]
	s.mu.Unlock()
	if pending || claimed {
		t.Fatalf("a refused token left pending=%v claimed=%v", pending, claimed)
	}
}

// A restart forgets memory, not the rotation.
func TestRoomName_ARestartKeepsTheRotatedRoom(t *testing.T) {
	store := newFakeRoomNames()
	store.rows["ch1"] = "srv1:ch1:abc"
	s, _ := intruderHarness(t, speakingMember())
	s.roomNameStore = store

	resp, err := s.GenerateToken(context.Background(), "member", "m", "", "ch1")
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if got := tokenRoom(t, resp.Token); got != "srv1:ch1:abc" {
		t.Fatalf("after a restart the token names %q, want the rotated srv1:ch1:abc", got)
	}
}

// A read that loses a race with a rotation must not put the old name back in the cache.
func TestRoomName_AReadRacingARotationKeepsTheRotation(t *testing.T) {
	s, _ := intruderHarness(t, speakingMember())
	store := newFakeRoomNames()
	store.onGet = func() {
		s.roomNamesMu.Lock()
		s.roomNames["ch1"] = "srv1:ch1:rotated"
		s.roomNamesMu.Unlock()
	}
	s.roomNameStore = store

	got, err := s.roomNameFor(context.Background(), "srv1", "ch1")
	if err != nil || got != "srv1:ch1:rotated" {
		t.Fatalf("got %q, %v; want the rotation that landed during the read", got, err)
	}
}

// The passphrase goes with the room, whatever its name.
func TestRoomName_EmptyChannelDropsRotatedPassphrases(t *testing.T) {
	s, _ := intruderHarness(t, speakingMember())
	for _, name := range []string{"srv1:ch1", "srv1:ch1:abc", "srv1:ch2"} {
		if _, err := s.getOrCreateRoomPassphrase(name); err != nil {
			t.Fatal(err)
		}
	}
	s.mu.Lock()
	delete(s.states, "member")
	s.cleanupRoomPassphraseIfEmpty("ch1")
	left := len(s.roomPassphrases)
	_, other := s.roomPassphrases["srv1:ch2"]
	s.mu.Unlock()
	if left != 1 || !other {
		t.Fatalf("%d passphrases left (other channel kept: %v), want only srv1:ch2", left, other)
	}
}

// The rotated name is stored with the channel and goes with its row; the teardown of a deleted
// channel still has to reach the room the call is in.
func TestRoomName_ChannelDeleteTeardownReachesTheRotatedRoom(t *testing.T) {
	store := newFakeRoomNames()
	store.rows["ch1"] = "srv1:ch1:abc"
	s, sfu := intruderHarness(t, speakingMember())
	s.roomNameStore = store

	s.BeginChannelDelete("srv1", "ch1")
	store.mu.Lock()
	delete(store.rows, "ch1") // ON DELETE CASCADE
	store.mu.Unlock()
	s.removeParticipantFromLiveKit("srv1", "ch1", "member", "")

	if got := sfu.callLog(); len(got) != 1 || got[0] != "RemoveParticipant srv1:ch1:abc" {
		t.Fatalf("teardown calls %v, want RemoveParticipant on srv1:ch1:abc", got)
	}
}

// ── Rotation ────────────────────────────────────────────────────────────────────────────────────

func TestRotation_MovesTheChannelAndLocksTheIntruderOut(t *testing.T) {
	s, sfu := intruderHarness(t, speakingMember(), "kicked")
	store := newFakeRoomNames()
	s.roomNameStore = store
	if _, err := s.getOrCreateRoomPassphrase("srv1:ch1"); err != nil {
		t.Fatal(err)
	}

	s.sweepLiveKitReconciliation()

	requireRotated(t, s, sfu)
	stored, ok := store.row("ch1")
	if !ok {
		t.Fatal("the new room was not stored — a restart would send everyone back to the old one")
	}
	if _, channelID, ok := ParseRoomName(stored); !ok || channelID != "ch1" {
		t.Fatalf("stored room %q does not read back as ch1", stored)
	}
	resp, err := s.GenerateToken(context.Background(), "member", "m", "", "ch1")
	if err != nil {
		t.Fatalf("member's rejoin token: %v", err)
	}
	if got := tokenRoom(t, resp.Token); got != stored {
		t.Fatalf("the member rejoins %q, the channel is in %q", got, stored)
	}
	if _, err := s.GenerateToken(context.Background(), "kicked", "k", "", "ch1"); err == nil {
		t.Fatal("the intruder got a token for the new room")
	}
	s.mu.Lock()
	_, kept := s.roomPassphrases["srv1:ch1"]
	s.mu.Unlock()
	if kept {
		t.Fatal("the old room's passphrase outlived it")
	}
}

func TestRotation_OneRotationForEveryIntruderInTheRoom(t *testing.T) {
	s, sfu := intruderHarness(t, speakingMember(), "kicked1", "kicked2", "kicked2_ss")
	store := newFakeRoomNames()
	s.roomNameStore = store

	s.sweepLiveKitReconciliation()

	requireRotated(t, s, sfu)
	if store.sets != 1 {
		t.Fatalf("stored %d new rooms for one intrusion", store.sets)
	}
}

// Nobody who may be there moves anyone: not a member in voice, not one reconnecting after a restart.
func TestRotation_NoRotationWithOnlyLegitimateParticipants(t *testing.T) {
	perms := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
			return models.PermViewChannel | models.PermConnectVoice, nil
		},
	}
	s, sfu := intruderHarness(t, perms, "reconnecting", "reconnecting_ss")
	store := newFakeRoomNames()
	s.roomNameStore = store

	s.sweepLiveKitReconciliation()
	s.sweepLiveKitReconciliation()

	if got := sfu.ejected(); len(got) != 0 || store.sets != 0 {
		t.Fatalf("ejected %v, stored %d rooms — with nobody who may not be there", got, store.sets)
	}
}

// The new name could not be stored: today's behaviour, and the next sweep tries again.
func TestRotation_UnstoredNameFallsBackToRemoval(t *testing.T) {
	s, sfu := intruderHarness(t, speakingMember(), "kicked")
	store := newFakeRoomNames()
	store.setErr = errors.New("disk full")
	s.roomNameStore = store

	s.sweepLiveKitReconciliation()

	if got := sfu.deletedRooms(); len(got) != 0 {
		t.Fatalf("deleted %v without a stored new room — a restart would reopen the old one", got)
	}
	if got := sfu.removedIDs(); len(got) != 1 || got[0] != "kicked" {
		t.Fatalf("removed %v, want the intruder removed as before rotation existed", got)
	}
	if now, _ := s.roomNameFor(context.Background(), "srv1", "ch1"); now != "srv1:ch1" {
		t.Fatalf("channel moved to %q although the move was not stored", now)
	}

	store.mu.Lock()
	store.setErr = nil
	store.mu.Unlock()
	s.sweepLiveKitReconciliation()
	if got := sfu.deletedRooms(); len(got) != 1 || got[0] != "srv1:ch1" {
		t.Fatalf("the next sweep deleted %v, want the rotation retried", got)
	}
}

// The old room could not be deleted: the intruders are taken out of it, and the deletion is retried.
func TestRotation_UndeletedRoomRemovesTheIntrudersAndRetries(t *testing.T) {
	s, sfu := intruderHarness(t, speakingMember(), "kicked")
	sfu.mu.Lock()
	sfu.failDelete = true
	sfu.mu.Unlock()

	s.sweepLiveKitReconciliation()

	calls := strings.Join(sfu.callLog(), "|")
	if !strings.Contains(calls, "DeleteRoom srv1:ch1|RemoveParticipant srv1:ch1") {
		t.Fatalf("calls %s, want a failed delete followed by removal from the old room", calls)
	}

	// The fake lists one roster for every room; the intruder was removed and has no token for the
	// new room, so the new room lists only the member.
	sfu.mu.Lock()
	sfu.failDelete = false
	sfu.roster = []string{"member"}
	sfu.mu.Unlock()
	s.sweepLiveKitReconciliation()
	if got := sfu.deletedRooms(); len(got) != 1 || got[0] != "srv1:ch1" {
		t.Fatalf("deleted %v on the retry, want srv1:ch1", got)
	}
}

// A token minted just before the rotation names the old room. It is deleted again for the watch,
// also when nobody is in voice any more, and then forgotten.
func TestRotation_OldRoomIsDeletedAgainDuringTheWatchOnly(t *testing.T) {
	s, sfu := intruderHarness(t, speakingMember(), "kicked")
	s.sweepLiveKitReconciliation()
	s.mu.Lock()
	delete(s.states, "member")
	s.mu.Unlock()

	s.sweepLiveKitReconciliation()
	if got := sfu.deletedRooms(); len(got) != 2 {
		t.Fatalf("deleted %v, want the old room deleted again during its watch", got)
	}

	s.roomNamesMu.Lock()
	r := s.retiredRooms["srv1:ch1"]
	r.until = time.Now().Add(-time.Second)
	s.retiredRooms["srv1:ch1"] = r
	s.roomNamesMu.Unlock()
	s.sweepLiveKitReconciliation()
	s.sweepLiveKitReconciliation()
	if got := sfu.deletedRooms(); len(got) != 2 {
		t.Fatalf("deleted %v, want no deletions after the watch", got)
	}
}

// A listing of a room the channel is no longer in moves nothing: the room it names is not the
// channel's, and storing a new name or deleting a room on its word would be acting on stale state.
func TestRotation_ARoomThatIsNoLongerTheChannelsIsNotRotated(t *testing.T) {
	s, sfu := intruderHarness(t, speakingMember())
	store := newFakeRoomNames()
	s.roomNameStore = store
	s.roomNamesMu.Lock()
	s.roomNames["ch1"] = "srv1:ch1:current"
	s.roomNamesMu.Unlock()

	s.rotateRoom("srv1", "ch1", roomRef{name: "srv1:ch1", instanceID: "lk1"}, []string{"kicked"})

	if store.sets != 0 || len(sfu.callLog()) != 0 {
		t.Fatalf("stored %d names and called %v for a room the channel is not in", store.sets, sfu.callLog())
	}
	if now, _ := s.roomNameFor(context.Background(), "srv1", "ch1"); now != "srv1:ch1:current" {
		t.Fatalf("channel moved to %q", now)
	}
}
