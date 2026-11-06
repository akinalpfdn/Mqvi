package services

import (
	"context"
	"testing"
	"time"
)

// A channel's overrides go with its row. From then on a hidden channel reads as visible to the base
// view, so a reader whose snapshot holds the call and whose permission read lands after the delete
// would show it to members who never could see it. Each test deletes the hidden channel in exactly
// that gap: after the reader's snapshot, inside its read.

// deleteHiddenDuringRead arranges for the next permission read to happen after staff was deleted:
// BeginChannelDelete has run, and with the overrides gone member reads as a viewer.
func deleteHiddenDuringRead(h *audienceHarness) {
	h.view.onRead = func() {
		h.svc.BeginChannelDelete(audServer, hiddenCh)
		h.view.viewers[hiddenCh] = append(h.view.viewers[hiddenCh], "member")
	}
}

func TestDeletedChannel_ReadySyncDoesNotShowIt(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	deleteHiddenDuringRead(h)

	states, timers := h.svc.VisibleVoiceStates(context.Background(), "member", []string{audServer})

	for _, st := range states {
		if st.ChannelID == hiddenCh {
			t.Fatalf("ready sync showed %s in the deleted hidden channel", st.UserID)
		}
	}
	if _, ok := timers[hiddenCh]; ok {
		t.Fatal("ready sync carried the deleted hidden channel's timer")
	}
}

func TestDeletedChannel_ServerResyncDoesNotShowIt(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.log.reset()
	deleteHiddenDuringRead(h)

	h.svc.ResyncServerVisibility(audServer)

	h.requireNothingAbout("member", hiddenCh, "insider")
}

func TestDeletedChannel_JoinSyncDoesNotShowIt(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.log.reset()
	deleteHiddenDuringRead(h)

	h.svc.SyncServerStatesToUser("member", audServer)

	h.requireNothingAbout("member", hiddenCh, "insider")
}

// Events of a channel being deleted reach only its participants.
func TestDeletedChannel_LiveEventsReachOnlyParticipants(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.svc.BeginChannelDelete(audServer, hiddenCh)
	h.view.viewers[hiddenCh] = append(h.view.viewers[hiddenCh], "member")
	h.log.reset()

	h.join("admin", hiddenCh)

	h.requireNothingAbout("member", hiddenCh, "insider", "admin")
}

// The delete failed: the call is visible again, and what its viewers missed is replaced in.
func TestDeletedChannel_AbortGivesTheCallBack(t *testing.T) {
	h := newAudienceHarness(t)
	h.svc.BeginChannelDelete(audServer, hiddenCh)
	h.join("insider", hiddenCh) // admin, a viewer, is not told while the channel is marked
	if got := mentions(h.log.to("admin"), "insider"); len(got) != 0 {
		t.Fatalf("admin was told about a call in a channel being deleted: %v", got)
	}

	h.svc.AbortChannelDelete(audServer, hiddenCh)

	if got, ok := lastSync(h, "admin"); !ok || got != "insider@"+hiddenCh {
		t.Fatalf("admin's resync = %q (sent %v), want insider back in %s", got, ok, hiddenCh)
	}
	h.requireNothingAbout("member", hiddenCh, "insider")
}

// Finish takes out the channel's participants only; one who moved on keeps their call.
func TestDeletedChannel_FinishClosesThatChannelOnly(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.join("admin", openCh)
	h.svc.BeginChannelDelete(audServer, hiddenCh)

	h.svc.FinishChannelDelete(audServer, hiddenCh)

	if st := h.svc.GetUserVoiceState("insider"); st != nil {
		t.Fatalf("insider is still in voice: %+v", st)
	}
	if st := h.svc.GetUserVoiceState("admin"); st == nil || st.ChannelID != openCh {
		t.Fatalf("admin lost a call in another channel: %+v", st)
	}
}

func TestDeletedChannel_MarksExpire(t *testing.T) {
	h := newAudienceHarness(t)
	e := h.svc.egress
	e.markDeleted("old")
	e.deletedMu.Lock()
	e.deleted["old"] = time.Now().Add(-deletedChannelTTL - time.Second)
	e.deletedMu.Unlock()

	e.markDeleted("new")

	if e.isDeleted("old") {
		t.Fatal("a mark outlived its TTL — the set would grow with every deleted channel")
	}
	if !e.isDeleted("new") {
		t.Fatal("the new mark is missing")
	}
}
