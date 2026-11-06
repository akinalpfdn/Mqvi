package services

import (
	"context"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
)

// A user moved by a moderator into a channel they cannot connect to is in its room on a force-move
// token. VoiceState.MovedIn and the pending marker say so, but both live in memory; after a restart
// only the mark signed into that token is left. Without it the sweep takes them for an intruder and
// rotates the room on everyone.

func tokenClaims(t *testing.T, token string) *auth.ClaimGrants {
	t.Helper()
	v, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}
	_, claims, err := v.Verify("devsecret")
	if err != nil {
		t.Fatalf("verify token: %v", err)
	}
	return claims
}

// viewOnly may see ch1 but not connect; "member" may connect and speak.
func viewOnly() *testutil.MockChannelPermResolver {
	return &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, userID, _ string) (models.Permission, error) {
			if userID == "member" {
				return models.PermViewChannel | models.PermConnectVoice | models.PermSpeak, nil
			}
			return models.PermViewChannel | models.PermSpeak, nil
		},
	}
}

func TestMovedIn_ForceMoveTokenCarriesTheMark(t *testing.T) {
	s, _ := intruderHarness(t, viewOnly())
	s.mu.Lock()
	s.forceMoveGrants["moved"] = forceMoveGrant{channelID: "ch1", expiresAt: time.Now().Add(time.Minute)}
	s.mu.Unlock()

	resp, err := s.GenerateToken(context.Background(), "moved", "m", "", "ch1")
	if err != nil {
		t.Fatalf("token on the grant: %v", err)
	}
	claims := tokenClaims(t, resp.Token)
	if claims.Attributes[movedInAttribute] != "1" {
		t.Fatalf("attributes %v, want the moved-in mark", claims.Attributes)
	}
	if claims.Video.GetCanUpdateOwnMetadata() {
		t.Fatal("the token lets its holder change their own attributes — the mark could be forged or dropped")
	}
}

func TestMovedIn_AnOrdinaryTokenCarriesNoMark(t *testing.T) {
	s, _ := intruderHarness(t, viewOnly())

	resp, err := s.GenerateToken(context.Background(), "member", "m", "", "ch1")
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if mark, ok := tokenClaims(t, resp.Token).Attributes[movedInAttribute]; ok {
		t.Fatalf("an ordinary token carries the mark (%q)", mark)
	}
}

func TestMovedIn_AMovedUsersScreenShareCarriesTheMark(t *testing.T) {
	s, _ := intruderHarness(t, viewOnly())
	s.mu.Lock()
	s.states["moved"] = &models.VoiceState{UserID: "moved", ChannelID: "ch1", ServerID: "srv1", MovedIn: true}
	s.mu.Unlock()

	moved, err := s.GenerateScreenShareToken(context.Background(), "moved", "m", "", "ch1")
	if err != nil {
		t.Fatalf("moved user's share token: %v", err)
	}
	if tokenClaims(t, moved.Token).Attributes[movedInAttribute] != "1" {
		t.Fatal("a moved user's share carries no mark")
	}
	plain, err := s.GenerateScreenShareToken(context.Background(), "member", "m", "", "ch1")
	if err != nil {
		t.Fatalf("member's share token: %v", err)
	}
	if _, ok := tokenClaims(t, plain.Token).Attributes[movedInAttribute]; ok {
		t.Fatal("a member's own share carries the mark")
	}
}

// After a restart: no state, no pending marker, no ConnectVoice — only the mark. A member stays.
func TestMovedIn_AfterARestartAMovedMemberDoesNotRotateTheRoom(t *testing.T) {
	mark := map[string]string{movedInAttribute: "1"}
	for _, tc := range []struct {
		roster []string
		marked string
	}{
		{[]string{"moved"}, "moved"},
		{[]string{"moved", "moved_ss"}, "moved"}, // the share is judged by its owner's mark
		{[]string{"moved_ss"}, "moved_ss"},       // the owner's participant is gone; the share's own mark
	} {
		roster := tc.roster
		s, sfu := intruderHarness(t, viewOnly(), roster...)
		s.membership = memberOf{"srv1:moved": true}
		sfu.mu.Lock()
		sfu.attrs = map[string]map[string]string{tc.marked: mark}
		sfu.mu.Unlock()

		s.sweepLiveKitReconciliation()

		if got := sfu.ejected(); len(got) != 0 {
			t.Fatalf("roster %v: ejected %v — a moved member was taken for an intruder", roster, got)
		}
	}
}

// The mark stands in for ConnectVoice, not for membership: a moved user who was kicked since is
// an intruder like any other.
func TestMovedIn_AMovedUserNoLongerAMemberStillRotatesTheRoom(t *testing.T) {
	s, sfu := intruderHarness(t, viewOnly(), "moved")
	s.membership = memberOf{}
	sfu.mu.Lock()
	sfu.attrs = map[string]map[string]string{"moved": {movedInAttribute: "1"}}
	sfu.mu.Unlock()

	s.sweepLiveKitReconciliation()

	requireRotated(t, s, sfu)
}

// Without the mark nothing changes: no ConnectVoice and no state is an intruder.
func TestMovedIn_WithoutTheMarkTheOldRuleApplies(t *testing.T) {
	s, sfu := intruderHarness(t, viewOnly(), "moved")
	s.membership = memberOf{"srv1:moved": true}

	s.sweepLiveKitReconciliation()

	requireRotated(t, s, sfu)
}
