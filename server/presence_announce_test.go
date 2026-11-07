package main

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/ws"
)

// prefRecorder records what got persisted.
type prefRecorder struct {
	pref    models.UserStatus
	prefSet bool
}

func (r *prefRecorder) UpdateStatus(context.Context, string, models.UserStatus) error { return nil }
func (r *prefRecorder) UpdatePrefStatus(_ context.Context, _ string, pref models.UserStatus) error {
	r.pref, r.prefSet = pref, true
	return nil
}

type presenceSend struct {
	to   []string
	data ws.PresenceData
}

// presenceRecorder is the hub as announcePresence sees it.
type presenceRecorder struct {
	audience  []string
	invisible map[string]bool
	sends     []presenceSend
}

func (r *presenceRecorder) SetInvisible(userID string, invisible bool) {
	r.invisible[userID] = invisible
}
func (r *presenceRecorder) GetPresenceAudience(string) []string { return r.audience }
func (r *presenceRecorder) BroadcastToUsers(userIDs []string, e ws.Event) {
	r.sends = append(r.sends, presenceSend{userIDs, e.Data.(ws.PresenceData)})
}
func (r *presenceRecorder) BroadcastToUser(userID string, e ws.Event) {
	r.BroadcastToUsers([]string{userID}, e)
}

// Everyone entitled to the user's presence sees the visible status; only the user's own devices
// learn the pick — which is how they keep their status pickers in step with each other.
func TestAnnouncePresence_ThePickReachesOnlyTheUsersOwnDevices(t *testing.T) {
	hub := &presenceRecorder{audience: []string{"friend", "me", "peer"}, invisible: map[string]bool{}}
	users := &prefRecorder{}

	announcePresence(context.Background(), hub, users, "me", "offline", "offline", false)

	if users.pref != models.UserStatusOffline || !hub.invisible["me"] {
		t.Fatalf("pick persisted as %q, invisible=%t — want offline and invisible", users.pref, hub.invisible["me"])
	}
	for _, s := range hub.sends {
		for _, to := range s.to {
			if to != "me" && s.data.PrefStatus != "" {
				t.Fatalf("%s was told the pick %q", to, s.data.PrefStatus)
			}
		}
	}
	var others, self []string
	for _, s := range hub.sends {
		if s.data.PrefStatus == "offline" && len(s.to) == 1 && s.to[0] == "me" {
			self = s.to
		} else if s.data.Status == "offline" {
			others = append(others, s.to...)
		}
	}
	if len(self) != 1 || len(others) != 2 {
		t.Fatalf("own devices got the pick: %v; others got the status: %v — want me, and friend+peer", self, others)
	}
}

// An automatic flip changes what others see but never the stored pick.
func TestAnnouncePresence_AnAutomaticFlipLeavesThePickAlone(t *testing.T) {
	hub := &presenceRecorder{audience: []string{"me"}, invisible: map[string]bool{}}
	users := &prefRecorder{}

	announcePresence(context.Background(), hub, users, "me", "idle", "online", true)

	if users.prefSet {
		t.Fatalf("an automatic flip persisted the pick %q", users.pref)
	}
	if len(hub.sends) == 0 || hub.sends[len(hub.sends)-1].data.Status != "idle" {
		t.Fatalf("sends %+v, want idle announced", hub.sends)
	}
}
