package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"
)

// One server, two voice channels. "staff" is hidden from everyone but admin and insider; "lobby"
// is open. A member who cannot see staff must learn nothing about it: not its id, not its name, not
// who is in it, not that a call is running there.
const (
	audServer = "srv1"
	hiddenCh  = "staff"
	openCh    = "lobby"
	otherSrv  = "srv2"
	otherCh   = "elsewhere"
)

type audienceHarness struct {
	t    *testing.T
	svc  *voiceService
	log  *deliveryLog
	view *viewTable
}

func newAudienceHarness(t *testing.T) *audienceHarness {
	t.Helper()
	log := &deliveryLog{}
	view := &viewTable{
		online: []string{"admin", "member", "insider", "wanderer"},
		viewers: map[string][]string{
			hiddenCh: {"admin", "insider"},
			openCh:   {"admin", "member", "insider", "wanderer", "newbie"},
			otherCh:  {"insider"},
		},
	}
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			server := audServer
			if id == otherCh {
				server = otherSrv
			}
			return &models.Channel{ID: id, Name: id, ServerID: server, Type: models.ChannelTypeVoice}, nil
		},
	}
	gates := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
			return models.PermAll, nil // the voice gates are not under test here; who hears about it is
		},
	}
	svc := NewVoiceService(channels, &mockLiveKitGetter{}, nil, gates, log.broadcaster(), view, view,
		nil, nil, nil, &testutil.MockFileURLSigner{})
	return &audienceHarness{t: t, svc: inlineEgress(svc), log: log, view: view}
}

func (h *audienceHarness) join(userID, channelID string) {
	h.t.Helper()
	if err := h.svc.JoinChannel(userID, userID, userID, "", channelID, false, false); err != nil {
		h.t.Fatalf("join %s → %s: %v", userID, channelID, err)
	}
}

// mentions reports the events whose payload names any needle — the channel id, its name or a
// participant — wherever in the payload it appears.
func mentions(events []ws.Event, needles ...string) []string {
	var hits []string
	for _, e := range events {
		raw, _ := json.Marshal(e)
		for _, n := range needles {
			if strings.Contains(string(raw), `"`+n+`"`) {
				hits = append(hits, string(raw))
				break
			}
		}
	}
	return hits
}

func (h *audienceHarness) requireNothingAbout(userID string, needles ...string) {
	h.t.Helper()
	if hits := mentions(h.log.to(userID), needles...); len(hits) > 0 {
		h.t.Fatalf("%s was told about %v:\n%s", userID, needles, strings.Join(hits, "\n"))
	}
}

func (h *audienceHarness) requireReceived(userID string, op, action, channelID string) {
	h.t.Helper()
	for _, e := range h.log.to(userID) {
		if e.Op != op {
			continue
		}
		if action == "" {
			return
		}
		if d, ok := e.Data.(ws.VoiceStateUpdateBroadcast); ok && d.Action == action && d.ChannelID == channelID {
			return
		}
	}
	h.t.Fatalf("%s did not receive %s/%s in %s; got %s", userID, op, action, channelID, opsOf(h.log.to(userID)))
}

func opsOf(events []ws.Event) string {
	var parts []string
	for _, e := range events {
		p := e.Op
		if d, ok := e.Data.(ws.VoiceStateUpdateBroadcast); ok {
			p += ":" + d.Action + ":" + d.ChannelID
		}
		parts = append(parts, p)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// ─── Live events ───

func TestHiddenVoice_JoinReachesOnlyViewersAndTheJoiner(t *testing.T) {
	h := newAudienceHarness(t)

	h.join("insider", hiddenCh)

	h.requireReceived("admin", ws.OpVoiceStateUpdate, "join", hiddenCh)
	h.requireReceived("admin", ws.OpVoiceChannelTimerStart, "", "")
	h.requireReceived("insider", ws.OpVoiceStateUpdate, "join", hiddenCh)
	if got := h.log.to("member"); len(got) != 0 {
		t.Fatalf("member got %s for a join to a channel they cannot see", opsOf(got))
	}
}

// Moving from a visible channel to a hidden one must look like leaving, not vanish and not point.
func TestHiddenVoice_SwitchIntoAHiddenChannelLooksLikeALeave(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", openCh)
	h.requireReceived("member", ws.OpVoiceStateUpdate, "join", openCh)
	h.log.reset()

	h.join("insider", hiddenCh)

	h.requireReceived("member", ws.OpVoiceStateUpdate, "leave", openCh)
	h.requireNothingAbout("member", hiddenCh)
	h.requireReceived("admin", ws.OpVoiceStateUpdate, "join", hiddenCh)
}

func TestHiddenVoice_StateUpdatesAndLeaveStayInside(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.log.reset()

	yes, no := true, false
	if err := h.svc.UpdateState("insider", &yes, nil, &yes, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.UpdateState("insider", nil, nil, &no, nil); err != nil { // stream ends: viewer count reset
		t.Fatal(err)
	}
	if err := h.svc.LeaveChannel("insider"); err != nil {
		t.Fatal(err)
	}

	if got := h.log.to("member"); len(got) != 0 {
		t.Fatalf("member got %s about a hidden channel", opsOf(got))
	}
	h.requireReceived("admin", ws.OpVoiceStateUpdate, "update", hiddenCh)
	h.requireReceived("admin", ws.OpScreenShareViewerUpdate, "", "")
	h.requireReceived("admin", ws.OpVoiceStateUpdate, "leave", hiddenCh)
	h.requireReceived("admin", ws.OpVoiceChannelTimerStop, "", "")
	// The leaver is told too, though no longer a participant — their other devices hold the state.
	h.requireReceived("insider", ws.OpVoiceStateUpdate, "leave", hiddenCh)
	h.requireReceived("insider", ws.OpVoiceChannelTimerStop, "", "")
}

func TestHiddenVoice_ScreenShareViewersStayInside(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.join("admin", hiddenCh)
	yes := true
	if err := h.svc.UpdateState("insider", nil, nil, &yes, nil); err != nil {
		t.Fatal(err)
	}
	h.log.reset()

	h.svc.WatchScreenShare("admin", "insider", true)
	h.svc.WatchScreenShare("admin", "insider", false)
	if err := h.svc.LeaveChannel("insider"); err != nil { // streamer leaves: final count goes out
		t.Fatal(err)
	}

	h.requireReceived("admin", ws.OpScreenShareViewerUpdate, "", "")
	h.requireNothingAbout("member", hiddenCh, "insider")
}

func TestHiddenVoice_AdminMuteStaysInside(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.log.reset()

	deafen := true // deafen only: mute would also call the SFU, which is not under test here
	if err := h.svc.AdminUpdateState(context.Background(), "admin", "insider", nil, &deafen); err != nil {
		t.Fatal(err)
	}

	h.requireReceived("insider", ws.OpVoiceStateUpdate, "update", hiddenCh)
	h.requireReceived("admin", ws.OpVoiceStateUpdate, "update", hiddenCh)
	if got := h.log.to("member"); len(got) != 0 {
		t.Fatalf("member got %s about a hidden channel", opsOf(got))
	}
}

// A user moved into a channel they cannot see is a participant there: they are told everything
// about it from then on, and get the participants already in it, before the signal to switch rooms.
func TestHiddenVoice_ForceMoveIntoHiddenChannel(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.join("wanderer", openCh)
	h.log.reset()

	if err := h.svc.MoveUser(context.Background(), "admin", "wanderer", hiddenCh); err != nil {
		t.Fatal(err)
	}

	h.requireReceived("member", ws.OpVoiceStateUpdate, "leave", openCh)
	h.requireNothingAbout("member", hiddenCh, "insider")

	got := h.log.to("wanderer")
	var sync *ws.VoiceServerStatesSyncData
	syncAt, moveAt := -1, -1
	for i, e := range got {
		switch e.Op {
		case ws.OpVoiceServerStatesSync:
			d := e.Data.(ws.VoiceServerStatesSyncData)
			sync, syncAt = &d, i
		case ws.OpVoiceForceMove:
			moveAt = i
		}
	}
	if sync == nil || moveAt < 0 || syncAt > moveAt {
		t.Fatalf("wanderer got %s; want a server sync before the force move", opsOf(got))
	}
	sawInsider := false
	for _, st := range sync.States {
		if st.UserID == "insider" && st.ChannelID == hiddenCh {
			sawInsider = true
		}
	}
	if !sawInsider || sync.ChannelTimers[hiddenCh] == 0 {
		t.Fatalf("sync %+v lacks the hidden channel's participants or timer", sync)
	}
}

// Leaving a channel they could only see as a participant must clear it from their client.
func TestHiddenVoice_LeavingAHiddenChannelClearsIt(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.join("wanderer", openCh)
	if err := h.svc.MoveUser(context.Background(), "admin", "wanderer", hiddenCh); err != nil {
		t.Fatal(err)
	}
	h.log.reset()

	if err := h.svc.LeaveChannel("wanderer"); err != nil {
		t.Fatal(err)
	}

	var last *ws.VoiceServerStatesSyncData
	for _, e := range h.log.to("wanderer") {
		if e.Op == ws.OpVoiceServerStatesSync {
			d := e.Data.(ws.VoiceServerStatesSyncData)
			last = &d
		}
	}
	if last == nil {
		t.Fatalf("wanderer got %s; want a server sync clearing the hidden channel", opsOf(h.log.to("wanderer")))
	}
	if hits := mentions([]ws.Event{{Data: last}}, hiddenCh, "insider"); len(hits) > 0 {
		t.Fatalf("the clearing sync still carries the hidden channel: %s", hits[0])
	}
}

// The leaver is told of their own leave and of the timer their leave stopped even when they cannot
// see the channel — their other devices hold the state, and nothing else would clear it.
func TestHiddenVoice_ALeaverWhoCannotSeeTheChannelIsStillTold(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("wanderer", openCh)
	if err := h.svc.MoveUser(context.Background(), "admin", "wanderer", hiddenCh); err != nil {
		t.Fatal(err)
	}
	h.log.reset()

	if err := h.svc.LeaveChannel("wanderer"); err != nil {
		t.Fatal(err)
	}

	h.requireReceived("wanderer", ws.OpVoiceStateUpdate, "leave", hiddenCh)
	h.requireReceived("wanderer", ws.OpVoiceChannelTimerStop, "", "")
}

// A member who can see the channel needs no resync on joining or leaving it.
func TestHiddenVoice_NoResyncForAVisibleChannel(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("member", openCh)
	if err := h.svc.LeaveChannel("member"); err != nil {
		t.Fatal(err)
	}
	for _, e := range h.log.to("member") {
		if e.Op == ws.OpVoiceServerStatesSync {
			t.Fatalf("member was resynced for a channel they can see: %s", opsOf(h.log.to("member")))
		}
	}
}

func TestHiddenVoice_AdminDisconnectStaysInsideAndEndsInTheSignal(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.log.reset()

	if err := h.svc.AdminDisconnectUser(context.Background(), "admin", "insider"); err != nil {
		t.Fatal(err)
	}

	got := h.log.to("insider")
	if len(got) == 0 || got[len(got)-1].Op != ws.OpVoiceForceDisconnect {
		t.Fatalf("insider got %s; want the leave first and force_disconnect last", opsOf(got))
	}
	h.requireReceived("insider", ws.OpVoiceStateUpdate, "leave", hiddenCh)
	if got := h.log.to("member"); len(got) != 0 {
		t.Fatalf("member got %s about a hidden channel", opsOf(got))
	}
}

// When the audience cannot be resolved the event goes to the participants only. Withheld is
// recoverable on the next sync; leaked is not.
func TestHiddenVoice_ResolveFailureWithholdsFromNonParticipants(t *testing.T) {
	h := newAudienceHarness(t)
	h.view.fail = true

	h.join("insider", hiddenCh)

	h.requireReceived("insider", ws.OpVoiceStateUpdate, "join", hiddenCh)
	if got := h.log.to("member"); len(got) != 0 {
		t.Fatalf("member got %s while the audience could not be resolved", opsOf(got))
	}
	if got := mentions(h.log.to("admin"), hiddenCh); len(got) != 0 {
		t.Fatalf("a non-participant got the event while resolution failed: %v", got)
	}
}

// ─── Snapshots ───

func TestHiddenVoice_ServerJoinSyncShowsOnlyVisibleCalls(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.join("member", openCh)
	h.log.reset()

	h.svc.SyncServerStatesToUser("newbie", audServer)

	h.requireReceived("newbie", ws.OpVoiceStateUpdate, "join", openCh)
	h.requireReceived("newbie", ws.OpVoiceChannelTimerStart, "", "")
	h.requireNothingAbout("newbie", hiddenCh, "insider")
}

func TestHiddenVoice_VisibleVoiceStates(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.join("member", openCh)
	h.join("insider2", otherCh) // another server, which member is not asked about

	states, timers := h.svc.VisibleVoiceStates(context.Background(), "member", []string{audServer})
	if len(states) != 1 || states[0].ChannelID != openCh {
		t.Fatalf("member sees %+v; want only the open channel", states)
	}
	if _, ok := timers[hiddenCh]; ok || timers[openCh] == 0 {
		t.Fatalf("timers %v: hidden timer leaked or open timer missing", timers)
	}

	// Their own channel is always visible, even one they cannot view.
	if err := h.svc.MoveUser(context.Background(), "admin", "member", hiddenCh); err != nil {
		t.Fatal(err)
	}
	states, _ = h.svc.VisibleVoiceStates(context.Background(), "member", []string{audServer})
	if len(states) != 2 {
		t.Fatalf("a force-moved member sees %+v; want both people in their own channel", states)
	}

	// A failed visibility read leaves only their own channel.
	h.view.fail = true
	h.join("wanderer", openCh)
	states, _ = h.svc.VisibleVoiceStates(context.Background(), "member", []string{audServer})
	for _, st := range states {
		if st.ChannelID != hiddenCh {
			t.Fatalf("with visibility unavailable member saw %+v outside their own channel", st)
		}
	}
}

// ─── Permission changes ───

func syncFor(events []ws.Event) *ws.VoiceServerStatesSyncData {
	var last *ws.VoiceServerStatesSyncData
	for _, e := range events {
		if e.Op == ws.OpVoiceServerStatesSync {
			d := e.Data.(ws.VoiceServerStatesSyncData)
			last = &d
		}
	}
	return last
}

func TestHiddenVoice_GrantAndRevokeResync(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", hiddenCh)
	h.log.reset()

	h.view.viewers[hiddenCh] = append(h.view.viewers[hiddenCh], "member") // grant
	h.svc.ResyncChannelVisibility(audServer, hiddenCh)
	granted := syncFor(h.log.to("member"))
	if granted == nil || len(mentions([]ws.Event{{Data: granted}}, "insider")) == 0 {
		t.Fatalf("after the grant member got %+v; want the hidden channel's participants", granted)
	}

	h.log.reset()
	h.view.viewers[hiddenCh] = []string{"admin", "insider"} // revoke
	h.svc.ResyncChannelVisibility(audServer, hiddenCh)
	revoked := syncFor(h.log.to("member"))
	if revoked == nil {
		t.Fatal("after the revoke member was not resynced — they would keep the hidden participants")
	}
	if hits := mentions([]ws.Event{{Data: revoked}}, hiddenCh, "insider"); len(hits) > 0 {
		t.Fatalf("the revoke sync still carries the hidden channel: %s", hits[0])
	}
	if revoked.ServerID != audServer {
		t.Fatalf("sync for server %q, want %q — the client replaces only that server", revoked.ServerID, audServer)
	}
}

func TestHiddenVoice_ResyncScopes(t *testing.T) {
	h := newAudienceHarness(t)

	h.svc.ResyncChannelVisibility(audServer, hiddenCh) // nobody in it: nothing anyone holds changes
	h.svc.ResyncServerVisibility(audServer)            // nobody in voice at all
	if len(h.log.all) != 0 {
		t.Fatalf("resync of an empty server/channel sent %d events", len(h.log.all))
	}

	h.join("insider", hiddenCh)
	h.log.reset()
	h.svc.ResyncUserVisibility(audServer, "member")
	for _, d := range h.log.all {
		if d.to != "member" {
			t.Fatalf("a one-user resync reached %s", d.to)
		}
	}
	if syncFor(h.log.to("member")) == nil {
		t.Fatal("member was not resynced")
	}

	h.log.reset()
	h.svc.ResyncServerVisibility(audServer)
	for _, uid := range h.view.online {
		if syncFor(h.log.to(uid)) == nil {
			t.Fatalf("server resync missed online member %s", uid)
		}
	}
}

// ─── Scoped disconnects ───

func TestDisconnectUserFromServer_LeavesOtherServersAlone(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", otherCh)

	if h.svc.DisconnectUserFromServer("insider", audServer) {
		t.Fatal("removed from a server they are not in voice on")
	}
	if h.svc.GetUserVoiceState("insider") == nil {
		t.Fatal("a kick from one server ended a call on another")
	}
	if !h.svc.DisconnectUserFromServer("insider", otherSrv) || h.svc.GetUserVoiceState("insider") != nil {
		t.Fatal("not removed from the server they are in voice on")
	}
}

func TestDisconnectUserFromChannel_LeavesAMovedUserAlone(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", openCh)
	h.join("insider", hiddenCh)

	if h.svc.DisconnectUserFromChannel("insider", openCh) {
		t.Fatal("disconnected from a channel they already left")
	}
	if st := h.svc.GetUserVoiceState("insider"); st == nil || st.ChannelID != hiddenCh {
		t.Fatalf("state %+v; the user who moved on must keep their new call", st)
	}
}

// The AFK sweep reads its candidates, then spends time on the database before kicking. A user who
// joined another channel in between reset their activity there and must not be kicked from it.
func TestAFKSweep_DoesNotKickAUserWhoMovedSince(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", openCh)
	h.svc.mu.Lock()
	h.svc.states["insider"].LastActivity = time.Now().Add(-2 * time.Hour)
	h.svc.mu.Unlock()

	moved := false
	h.svc.afkTimeoutGetter = afkGetterFunc(func() {
		if !moved {
			moved = true
			h.join("insider", hiddenCh) // lands between the snapshot and the kick
		}
	})

	h.svc.sweepAFKUsers()

	if st := h.svc.GetUserVoiceState("insider"); st == nil || st.ChannelID != hiddenCh {
		t.Fatalf("state %+v; the user was kicked from the channel they moved to", st)
	}
	for _, e := range h.log.to("insider") {
		if e.Op == ws.OpVoiceAFKKick {
			t.Fatal("an AFK notice reached a user who was not kicked")
		}
	}
}

func TestAFKSweep_KicksTheIdleUser(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", openCh)
	h.svc.mu.Lock()
	h.svc.states["insider"].LastActivity = time.Now().Add(-2 * time.Hour)
	h.svc.mu.Unlock()
	h.svc.afkTimeoutGetter = afkGetterFunc(func() {})
	h.log.reset()

	h.svc.sweepAFKUsers()

	if h.svc.GetUserVoiceState("insider") != nil {
		t.Fatal("an idle user was not kicked")
	}
	got := h.log.to("insider")
	if len(got) == 0 || got[0].Op != ws.OpVoiceAFKKick {
		t.Fatalf("insider got %s; want the AFK notice before the leave", opsOf(got))
	}
}

// afkGetterFunc reports a one-minute AFK timeout, running hook first.
type afkGetterFunc func()

func (f afkGetterFunc) GetByID(_ context.Context, id string) (*models.Server, error) {
	f()
	return &models.Server{ID: id, Name: id, AFKTimeoutMinutes: 1}, nil
}

// Live enforcement re-resolves before disconnecting. A user who moved since into a channel where
// they hold ConnectVoice keeps that call.
func TestPermissionEnforce_DoesNotDisconnectAUserWhoMovedSince(t *testing.T) {
	h := newAudienceHarness(t)
	h.join("insider", openCh)
	snapshot := *h.svc.GetUserVoiceState("insider")

	h.join("insider", hiddenCh)
	h.svc.permResolver = &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, _, channelID string) (models.Permission, error) {
			if channelID == openCh {
				return 0, nil // lost ConnectVoice in the channel the enforcement is about
			}
			return models.PermAll, nil
		},
	}
	h.log.reset()

	h.svc.enforceVoicePermissionForParticipant(snapshot)

	if st := h.svc.GetUserVoiceState("insider"); st == nil || st.ChannelID != hiddenCh {
		t.Fatalf("state %+v; enforcement for one channel ended a call in another", st)
	}
	for _, e := range h.log.to("insider") {
		if e.Op == ws.OpVoiceForceDisconnect {
			t.Fatal("force_disconnect reached a user who was not disconnected")
		}
	}
}
