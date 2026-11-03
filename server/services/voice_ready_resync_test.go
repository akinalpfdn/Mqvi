package services

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/ws"
)

// The ready sync is read, then sent, beside the servers' event order, to a connection that is
// already registered. Whatever was queued in between may reach the client first and be undone by
// the older sync; ResyncVoiceSince repairs exactly the servers that moved, and nothing else.

func syncsTo(h *audienceHarness, userID string) int {
	n := 0
	for _, e := range h.log.to(userID) {
		if e.Op == ws.OpVoiceServerStatesSync {
			n++
		}
	}
	return n
}

func TestReadyResync_NothingQueuedSinceTheReadSendsNothing(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", openCh)
	_, _, mark := h.svc.ReadyVoiceStates(context.Background(), "member", []string{audServer, otherSrv})
	h.log.reset()

	h.svc.ResyncVoiceSince("member", mark)

	if got := h.log.to("member"); len(got) != 0 {
		t.Fatalf("member got %s although nothing moved — every connect would pay for a resync", opsOf(got))
	}
}

func TestReadyResync_AJoinAfterTheReadIsRepaired(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", openCh)
	states, _, mark := h.svc.ReadyVoiceStates(context.Background(), "member", []string{audServer, otherSrv})
	if len(states) != 1 {
		t.Fatalf("read %d states, want insider only", len(states))
	}
	h.join("wanderer", openCh) // queued after the read: may have reached member before the sync
	h.log.reset()

	h.svc.ResyncVoiceSince("member", mark)

	got, ok := lastSync(h, "member")
	if !ok || got != "insider@"+openCh+",wanderer@"+openCh && got != "wanderer@"+openCh+",insider@"+openCh {
		t.Fatalf("member's repair = %q (sent %v), want insider and wanderer in %s", got, ok, openCh)
	}
	if n := syncsTo(h, "member"); n != 1 {
		t.Fatalf("member got %d replaces, want one: the other server did not move", n)
	}
}

func TestReadyResync_ALeaveAfterTheReadIsRepaired(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", openCh)
	h.join("wanderer", openCh)
	_, _, mark := h.svc.ReadyVoiceStates(context.Background(), "member", []string{audServer})
	if err := h.svc.LeaveChannel("wanderer"); err != nil {
		t.Fatal(err)
	}
	h.log.reset()

	h.svc.ResyncVoiceSince("member", mark)

	if got, ok := lastSync(h, "member"); !ok || got != "insider@"+openCh {
		t.Fatalf("member's repair = %q (sent %v), want insider only — the sync would bring wanderer back", got, ok)
	}
}

// A server with no call at the read is in the mark too: a call starting there is the same race.
func TestReadyResync_ACallStartingInAQuietServerIsRepaired(t *testing.T) {
	h := newAudienceHarness(t)
	_, _, mark := h.svc.ReadyVoiceStates(context.Background(), "insider", []string{audServer, otherSrv})
	h.join("admin", otherCh)
	h.log.reset()

	h.svc.ResyncVoiceSince("insider", mark)

	var servers []string
	for _, e := range h.log.to("insider") {
		if e.Op == ws.OpVoiceServerStatesSync {
			servers = append(servers, e.ServerID)
		}
	}
	if strings.Join(servers, ",") != otherSrv {
		t.Fatalf("insider got replaces for %v, want %s only", servers, otherSrv)
	}
}

// The repair follows the user's visibility like every other resync.
func TestReadyResync_TheRepairShowsNoHiddenChannel(t *testing.T) {
	h := newAudienceHarness(t)
	_, _, mark := h.svc.ReadyVoiceStates(context.Background(), "member", []string{audServer})
	h.join("insider", hiddenCh)
	h.log.reset()

	h.svc.ResyncVoiceSince("member", mark)

	h.requireNothingAbout("member", hiddenCh, "insider")
}

// The mark is only as good as the count behind it: a task queued without going through submit would
// move nothing, and its race would go unrepaired.
func TestEgress_EveryTaskIsCounted(t *testing.T) {
	src, err := os.ReadFile("voice_egress.go")
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(src), "e.run("); n != 1 {
		t.Fatalf("voice_egress.go calls e.run %d times; only submit may, so every task is counted", n)
	}
}
