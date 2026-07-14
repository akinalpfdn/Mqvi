package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// stubDMRepo embeds the interface so only the three methods MarkRead actually reaches need to
// exist. Anything else it touched would nil-panic, which is the point: the test would tell us.
type stubDMRepo struct {
	repository.DMRepository

	channel *models.DMChannel
	moved   bool
	unread  int

	markedMessageID string // "" means MarkReadLatest was used
	markReadCalls   int
	latestCalls     int
}

func (r *stubDMRepo) GetChannelByID(context.Context, string) (*models.DMChannel, error) {
	return r.channel, nil
}

func (r *stubDMRepo) MarkRead(_ context.Context, _, _, messageID string) (bool, error) {
	r.markReadCalls++
	r.markedMessageID = messageID
	return r.moved, nil
}

func (r *stubDMRepo) MarkReadLatest(context.Context, string, string) (bool, error) {
	r.latestCalls++
	return r.moved, nil
}

func (r *stubDMRepo) CountUnread(context.Context, string, string) (int, error) {
	return r.unread, nil
}

// readPush records the retraction so the test can assert on the push GATE, not just the push.
type readPush struct {
	retracted []string // "userID|channelID"
}

func (p *readPush) NotifyDM(_, _, _ string, _ bool, _, _, _ string)           {}
func (p *readPush) NotifyCall(_, _ string, _ models.P2PCallType, _, _ string) {}
func (p *readPush) NotifyCallCancel(_, _, _ string)                           {}
func (p *readPush) NotifyDMRead(userID, dmChannelID string) {
	p.retracted = append(p.retracted, userID+"|"+dmChannelID)
}

func markReadService(moved bool, unread int) (*dmService, *stubDMRepo, *recordingHub, *readPush) {
	repo := &stubDMRepo{
		channel: &models.DMChannel{ID: "c1", User1ID: "alice", User2ID: "bob"},
		moved:   moved,
		unread:  unread,
	}
	hub := &recordingHub{}
	push := &readPush{}
	return &dmService{dmRepo: repo, hub: hub, pushNotifier: push}, repo, hub, push
}

// The endpoint takes a channel id from the URL. Nothing else stops a stranger from advancing —
// or reading — the read state of a conversation they are not in.
func TestMarkRead_RejectsSomeoneWhoIsNotInTheConversation(t *testing.T) {
	svc, repo, hub, push := markReadService(true, 0)

	_, err := svc.MarkRead(context.Background(), "mallory", "c1", "m1")

	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("a non-member marked another pair's DM read, got err=%v", err)
	}
	if repo.markReadCalls != 0 || repo.latestCalls != 0 {
		t.Error("the watermark was written for a user who is not in the conversation")
	}
	if len(hub.eventsFor("mallory", ws.OpDMRead)) != 0 || len(hub.eventsFor("alice", ws.OpDMRead)) != 0 {
		t.Error("a rejected mark-read still broadcast")
	}
	if len(push.retracted) != 0 {
		t.Error("a rejected mark-read still retracted a notification")
	}
}

func TestMarkRead_TellsOnlyTheReaderTheirOwnNewCount(t *testing.T) {
	svc, _, hub, _ := markReadService(true, 2)

	unread, err := svc.MarkRead(context.Background(), "alice", "c1", "m1")
	if err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if unread != 2 {
		t.Errorf("returned unread %d, want 2 — the count must be read back from the database, not assumed to be zero", unread)
	}

	own := hub.eventsFor("alice", ws.OpDMRead)
	if len(own) != 1 {
		t.Fatalf("%d dm_read events to the reader, want 1 — this is what clears the badge on their other devices", len(own))
	}
	data, _ := own[0].Data.(map[string]any)
	if data["unread_count"] != 2 || data["dm_channel_id"] != "c1" {
		t.Errorf("dm_read carried %v, want unread_count=2 dm_channel_id=c1", data)
	}

	// The other participant's unread is their own business — telling them would be a leak of
	// when their message was read, and would corrupt their badge.
	if n := len(hub.eventsFor("bob", ws.OpDMRead)); n != 0 {
		t.Errorf("the other participant got %d dm_read events", n)
	}
}

// The retraction only makes sense once nothing is left unread. Sending it while messages remain
// would pull a notification the user still needs off their lock screen.
func TestMarkRead_RetractsOnlyWhenTheConversationIsFullyRead(t *testing.T) {
	svc, _, _, push := markReadService(true, 3)
	if _, err := svc.MarkRead(context.Background(), "alice", "c1", "m1"); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if len(push.retracted) != 0 {
		t.Errorf("retracted the notification with 3 messages still unread: %v", push.retracted)
	}

	svc, _, _, push = markReadService(true, 0)
	if _, err := svc.MarkRead(context.Background(), "alice", "c1", "m1"); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if len(push.retracted) != 1 || push.retracted[0] != "alice|c1" {
		t.Errorf("retraction went to %v, want [alice|c1]", push.retracted)
	}
}

// Re-opening an already-read DM must be silent. Without this, every mount of a read conversation
// wakes every device the user owns and fires an FCM push.
func TestMarkRead_NoOpDoesNotWakeAnyoneOrPush(t *testing.T) {
	svc, _, hub, push := markReadService(false, 0) // the watermark did not move

	unread, err := svc.MarkRead(context.Background(), "alice", "c1", "m1")
	if err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if unread != 0 {
		t.Errorf("returned %d, want 0", unread)
	}
	if n := len(hub.eventsFor("alice", ws.OpDMRead)); n != 0 {
		t.Errorf("%d dm_read broadcasts for a watermark that did not move", n)
	}
	if len(push.retracted) != 0 {
		t.Errorf("pushed for a watermark that did not move: %v", push.retracted)
	}
}

// An empty id is the explicit "mark the whole conversation read". A named message is a watermark.
// Confusing the two is how a client that loaded nothing marked everything read.
func TestMarkRead_EmptyMessageIDMeansTheWholeConversation(t *testing.T) {
	svc, repo, _, _ := markReadService(true, 0)
	if _, err := svc.MarkRead(context.Background(), "alice", "c1", ""); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if repo.latestCalls != 1 || repo.markReadCalls != 0 {
		t.Errorf("empty id took the watermark path (latest=%d, watermark=%d)", repo.latestCalls, repo.markReadCalls)
	}

	svc, repo, _, _ = markReadService(true, 0)
	if _, err := svc.MarkRead(context.Background(), "alice", "c1", "m7"); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if repo.markReadCalls != 1 || repo.latestCalls != 0 {
		t.Errorf("a named message took the mark-everything path (latest=%d, watermark=%d)", repo.latestCalls, repo.markReadCalls)
	}
	if repo.markedMessageID != "m7" {
		t.Errorf("marked read up to %q, want m7", repo.markedMessageID)
	}
}
