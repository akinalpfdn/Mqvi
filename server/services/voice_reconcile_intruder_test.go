package services

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	livekit "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
)

// rosterSFU answers ListParticipants with a roster and records exactly which identities are removed,
// which rooms are deleted, and which room every call addressed.
type rosterSFU struct {
	srv        *httptest.Server
	mu         sync.Mutex
	roster     []string
	removed    []string
	deleted    []string
	calls      []string // "Method room", in order
	failLst    bool
	failDelete bool
	onList     func() // runs while the sweep waits on the list — after its snapshot, before judging
}

func newRosterSFU(t *testing.T, roster ...string) *rosterSFU {
	t.Helper()
	sfu := &rosterSFU{roster: roster}
	sfu.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/protobuf")
		var msg proto.Message
		switch {
		case strings.HasSuffix(r.URL.Path, "/ListParticipants"):
			sfu.record(t, r, "ListParticipants", &livekit.ListParticipantsRequest{})
			sfu.mu.Lock()
			fail, roster, hook := sfu.failLst, append([]string(nil), sfu.roster...), sfu.onList
			sfu.mu.Unlock()
			if hook != nil {
				hook()
			}
			if fail {
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
				return
			}
			resp := &livekit.ListParticipantsResponse{}
			for _, id := range roster {
				resp.Participants = append(resp.Participants, &livekit.ParticipantInfo{Identity: id})
			}
			msg = resp
		case strings.HasSuffix(r.URL.Path, "/RemoveParticipant"):
			req := &livekit.RoomParticipantIdentity{}
			sfu.record(t, r, "RemoveParticipant", req)
			sfu.mu.Lock()
			sfu.removed = append(sfu.removed, req.GetIdentity())
			sfu.mu.Unlock()
			msg = &livekit.RemoveParticipantResponse{}
		case strings.HasSuffix(r.URL.Path, "/DeleteRoom"):
			req := &livekit.DeleteRoomRequest{}
			sfu.record(t, r, "DeleteRoom", req)
			sfu.mu.Lock()
			fail := sfu.failDelete
			if !fail {
				sfu.deleted = append(sfu.deleted, req.GetRoom())
			}
			sfu.mu.Unlock()
			if fail {
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
				return
			}
			msg = &livekit.DeleteRoomResponse{}
		case strings.HasSuffix(r.URL.Path, "/UpdateParticipant"):
			sfu.record(t, r, "UpdateParticipant", &livekit.UpdateParticipantRequest{})
			msg = &livekit.ParticipantInfo{}
		default:
			t.Errorf("unexpected LiveKit call %s", r.URL.Path)
			msg = &livekit.ListParticipantsResponse{}
		}
		out, err := proto.Marshal(msg)
		if err != nil {
			t.Errorf("marshal: %v", err)
			return
		}
		_, _ = w.Write(out)
	}))
	t.Cleanup(sfu.srv.Close)
	return sfu
}

// roomRequest is every request that names a room.
type roomRequest interface {
	proto.Message
	GetRoom() string
}

func (s *rosterSFU) record(t *testing.T, r *http.Request, method string, req roomRequest) {
	body, _ := io.ReadAll(r.Body)
	if err := proto.Unmarshal(body, req); err != nil {
		t.Errorf("decode %s: %v", method, err)
	}
	s.mu.Lock()
	s.calls = append(s.calls, method+" "+req.GetRoom())
	s.mu.Unlock()
}

func (s *rosterSFU) callLog() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

func (s *rosterSFU) deletedRooms() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.deleted...)
}

// ejected is everyone the sweep pushed out: identities removed and rooms deleted.
func (s *rosterSFU) ejected() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]string(nil), s.removed...)
	for _, room := range s.deleted {
		out = append(out, "room "+room)
	}
	return out
}

func (s *rosterSFU) removedIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.removed...)
}

var errPermLookup = errors.New("permission lookup failed")

// connectPerms grants ConnectVoice to the listed users; "broken" cannot be resolved.
func connectPerms(allowed ...string) *testutil.MockChannelPermResolver {
	return &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, userID, _ string) (models.Permission, error) {
			if userID == "broken" {
				return 0, errPermLookup
			}
			for _, a := range allowed {
				if a == userID {
					return models.PermViewChannel | models.PermConnectVoice, nil
				}
			}
			return 0, nil
		},
	}
}

// intruderHarness: "member" is in voice in ch1, so the room is listed; the roster adds whoever a
// test puts there.
func intruderHarness(t *testing.T, perms *testutil.MockChannelPermResolver, roster ...string) (*voiceService, *rosterSFU) {
	t.Helper()
	sfu := newRosterSFU(t, append([]string{"member"}, roster...)...)
	s, _ := sweepHarness(t, sfu.srv.URL, "member")
	bindChannel(s, "ch1")
	s.permResolver = perms
	s.mu.Lock()
	s.states["member"] = &models.VoiceState{UserID: "member", ChannelID: "ch1", ServerID: "srv1"}
	s.mu.Unlock()
	return s, sfu
}

// A user taken out of voice still holds the token they joined with. Reconnecting with it puts them
// back in the room with no voice state; they must be removed.
func TestReconcile_RemovesAParticipantWithNoStateAndNoRight(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member"), "kicked")

	s.sweepLiveKitReconciliation()

	requireRotated(t, s, sfu)
}

// After a restart every voice state is gone while the calls go on; clients re-assert when their
// websocket returns, an iOS app in the background only when it is opened. Anyone who may connect
// must be left in the call meanwhile.
func TestReconcile_KeepsAParticipantWhoMayConnect(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member", "reconnecting"), "reconnecting")

	s.sweepLiveKitReconciliation()

	if got := sfu.ejected(); len(got) != 0 {
		t.Fatalf("removed %v — a user who could rejoin anyway lost the call", got)
	}
}

// Between the token and the websocket join a user is in the room with no state. A force-moved user
// has no ConnectVoice, so the token minted on the grant is what covers them while they are a member.
func TestReconcile_KeepsAForceMovedUserMidJoin(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member"), "joining")
	s.membership = memberOf{"srv1:joining": true}
	s.markPendingJoin("ch1", "joining", true)

	s.sweepLiveKitReconciliation()

	if got := sfu.ejected(); len(got) != 0 {
		t.Fatalf("removed %v — a force-moved user mid-join lost the call", got)
	}
}

// An ordinary user mid-join is kept by their ConnectVoice, not by the token.
func TestReconcile_KeepsAUserMidJoinWhoMayConnect(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member", "joining"), "joining")
	s.markPendingJoin("ch1", "joining", false)

	s.sweepLiveKitReconciliation()

	if got := sfu.ejected(); len(got) != 0 {
		t.Fatalf("removed %v — a user mid-join lost the call", got)
	}
}

// A removed member keeps a token fresh by asking for one every 50 s. It must not keep them in the room.
func TestReconcile_RemovesAUserWhoseOnlyClaimIsAFreshToken(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member"), "kicked")
	s.membership = memberOf{}
	s.markPendingJoin("ch1", "kicked", false)

	s.sweepLiveKitReconciliation()

	requireRotated(t, s, sfu)
}

func TestReconcile_ForceMoveTokenNeedsMembership(t *testing.T) {
	for _, tc := range []struct {
		name    string
		user    string
		removed bool
	}{
		{"no longer a member: removed", "kicked", true},
		{"membership unreadable: kept", "broken", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, sfu := intruderHarness(t, connectPerms("member"), tc.user)
			s.membership = memberOf{}
			s.markPendingJoin("ch1", tc.user, true)

			s.sweepLiveKitReconciliation()

			if tc.removed {
				requireRotated(t, s, sfu)
			} else if got := sfu.ejected(); len(got) != 0 {
				t.Fatalf("ejected %v, want %s kept", got, tc.user)
			}
		})
	}
}

// A user who joined after the sweep's snapshot is in voice by the time they are judged.
func TestReconcile_KeepsAUserWhoJoinedAfterTheSnapshot(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member"), "late")
	sfu.mu.Lock()
	sfu.onList = func() {
		s.mu.Lock()
		s.states["late"] = &models.VoiceState{UserID: "late", ChannelID: "ch1", ServerID: "srv1"}
		s.mu.Unlock()
	}
	sfu.mu.Unlock()

	s.sweepLiveKitReconciliation()

	if got := sfu.ejected(); len(got) != 0 {
		t.Fatalf("removed %v — judged against the snapshot instead of the current state", got)
	}
}

// A screen share is judged by its owner: a member's own share is no intruder, a removed user's is.
func TestReconcile_ScreenShareJudgedByItsOwner(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member"), "member_ss")
	s.sweepLiveKitReconciliation()
	if got := sfu.ejected(); len(got) != 0 {
		t.Fatalf("ejected %v — the member's own share", got)
	}

	s, sfu = intruderHarness(t, connectPerms("member"), "member_ss", "kicked_ss")
	s.sweepLiveKitReconciliation()
	requireRotated(t, s, sfu)
}

// In doubt, never remove: a permission that cannot be read keeps the participant.
func TestReconcile_KeepsAParticipantWhosePermissionCannotBeRead(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member"), "broken")

	s.sweepLiveKitReconciliation()

	if got := sfu.ejected(); len(got) != 0 {
		t.Fatalf("removed %v on an unreadable permission", got)
	}
}

// A room that cannot be listed is not judged at all.
func TestReconcile_RemovesNobodyWhenTheRoomCannotBeListed(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms("member"), "kicked")
	sfu.mu.Lock()
	sfu.failLst = true
	sfu.mu.Unlock()

	s.sweepLiveKitReconciliation()

	if got := sfu.ejected(); len(got) != 0 {
		t.Fatalf("removed %v from a room it could not list", got)
	}
	if s.GetUserVoiceState("member") == nil {
		t.Fatal("a listing failure reaped the member")
	}
}

// The voice members of the room are untouched by the new check, and the old direction still works:
// a state with nobody in the room is still reaped after its grace.
func TestReconcile_LeavesVoiceMembersAlone(t *testing.T) {
	s, sfu := intruderHarness(t, connectPerms())

	s.sweepLiveKitReconciliation()
	s.mu.Lock()
	s.livekitAbsentSince["member"] = time.Now().Add(-time.Hour) // would be reaped only if absent
	s.mu.Unlock()
	s.sweepLiveKitReconciliation()

	if got := sfu.ejected(); len(got) != 0 {
		t.Fatalf("removed %v — a member in voice and in the room", got)
	}
	if s.GetUserVoiceState("member") == nil {
		t.Fatal("a member present in the room was reaped")
	}
}

// ConnectVoice without ViewChannel is a hidden channel: an old token for it is no right to be there.
func TestReconcile_RemovesAParticipantWhoCannotSeeTheChannel(t *testing.T) {
	perms := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, userID, _ string) (models.Permission, error) {
			if userID == "member" {
				return models.PermViewChannel | models.PermConnectVoice, nil
			}
			return models.PermConnectVoice, nil
		},
	}
	s, sfu := intruderHarness(t, perms, "hidden")

	s.sweepLiveKitReconciliation()

	requireRotated(t, s, sfu)
}

// requireRotated: the intruder's room was deleted (which takes everyone in it out) and ch1 is in a new
// room now. Nobody was removed one by one — that is only the fallback.
func requireRotated(t *testing.T, s *voiceService, sfu *rosterSFU) {
	t.Helper()
	if got := sfu.deletedRooms(); len(got) != 1 || got[0] != "srv1:ch1" {
		t.Fatalf("deleted rooms %v, want exactly [srv1:ch1]", got)
	}
	if got := sfu.removedIDs(); len(got) != 0 {
		t.Fatalf("removed %v one by one although the room was deleted", got)
	}
	now, err := s.roomNameFor(context.Background(), "srv1", "ch1")
	if err != nil || now == "srv1:ch1" {
		t.Fatalf("ch1 is still in %q (%v) — the intruder's token still names the live room", now, err)
	}
}
