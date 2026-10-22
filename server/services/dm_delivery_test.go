package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"
)

// deliveryDMRepo answers only what MarkDelivered and GetMessages reach; anything else nil-panics.
type deliveryDMRepo struct {
	repository.DMRepository

	channel   *models.DMChannel
	moved     bool
	mark      *models.DMDeliveryMark
	messages  []models.DMMessage
	delivered map[string]bool

	markCalls      int
	deliveredAsked string // whose watermark DeliveredMessageIDs was asked about
}

func (r *deliveryDMRepo) GetChannelByID(_ context.Context, id string) (*models.DMChannel, error) {
	if id != r.channel.ID {
		return nil, pkg.ErrNotFound
	}
	return r.channel, nil
}

func (r *deliveryDMRepo) MarkDelivered(context.Context, string, string, string) (bool, error) {
	r.markCalls++
	return r.moved, nil
}

func (r *deliveryDMRepo) MarkDeliveredLatest(context.Context, string, string) (bool, error) {
	r.markCalls++
	return r.moved, nil
}

func (r *deliveryDMRepo) DeliveryMark(context.Context, string, string) (*models.DMDeliveryMark, error) {
	return r.mark, nil
}

func (r *deliveryDMRepo) GetMessages(context.Context, string, string, int) ([]models.DMMessage, error) {
	return r.messages, nil
}

func (r *deliveryDMRepo) GetAttachmentsByMessageIDs(context.Context, []string) (map[string][]models.DMAttachment, error) {
	return map[string][]models.DMAttachment{}, nil
}

func (r *deliveryDMRepo) GetReactionsByMessageIDs(context.Context, []string) (map[string][]models.ReactionGroup, error) {
	return map[string][]models.ReactionGroup{}, nil
}

func (r *deliveryDMRepo) DeliveredMessageIDs(_ context.Context, userID, _ string, _ []string) (map[string]bool, error) {
	r.deliveredAsked = userID
	return r.delivered, nil
}

func deliveryService(moved bool) (*dmService, *deliveryDMRepo, *recordingHub) {
	repo := &deliveryDMRepo{
		channel: &models.DMChannel{ID: "c1", User1ID: "alice", User2ID: "bob"},
		moved:   moved,
		mark:    &models.DMDeliveryMark{MessageID: "m2", CreatedAt: time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)},
	}
	hub := &recordingHub{}
	return &dmService{dmRepo: repo, hub: hub, urlSigner: &testutil.MockFileURLSigner{}}, repo, hub
}

// Only someone in the conversation may say they received it — otherwise anyone could put a
// stranger's messages on a double tick.
func TestMarkDelivered_RejectsSomeoneWhoIsNotInTheConversation(t *testing.T) {
	svc, repo, hub := deliveryService(true)

	err := svc.MarkDelivered(context.Background(), "mallory", "c1", "m2")

	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
	if repo.markCalls != 0 || len(hub.sent) != 0 {
		t.Fatalf("a non-member's report was stored (%d) or announced (%d)", repo.markCalls, len(hub.sent))
	}
}

func TestMarkDelivered_TellsOnlyTheSender(t *testing.T) {
	svc, _, hub := deliveryService(true)

	if err := svc.MarkDelivered(context.Background(), "bob", "c1", "m2"); err != nil {
		t.Fatalf("MarkDelivered: %v", err)
	}

	got := hub.eventsFor("alice", ws.OpDMDelivered)
	if len(got) != 1 {
		t.Fatalf("%d dm_delivered events to the sender, want 1", len(got))
	}
	data, _ := got[0].Data.(map[string]any)
	if data["dm_channel_id"] != "c1" || data["message_id"] != "m2" {
		t.Errorf("dm_delivered carried %v", data)
	}
	if n := len(hub.eventsFor("bob", ws.OpDMDelivered)); n != 0 {
		t.Errorf("the receiver was told about their own delivery %d times", n)
	}
}

// A repeat or an older report changes nothing, and must not wake the sender's devices for it.
func TestMarkDelivered_StaysQuietWhenNothingMoved(t *testing.T) {
	svc, _, hub := deliveryService(false)

	if err := svc.MarkDelivered(context.Background(), "bob", "c1", "m1"); err != nil {
		t.Fatalf("MarkDelivered: %v", err)
	}
	if len(hub.sent) != 0 {
		t.Fatalf("a no-op report broadcast %d events", len(hub.sent))
	}
}

// A page tells the sender which of their own messages arrived, judged by the other participant's
// watermark, and leaves everyone else's messages alone.
func TestGetMessages_MarksOnlyOwnMessagesDelivered(t *testing.T) {
	svc, repo, _ := deliveryService(true)
	repo.messages = []models.DMMessage{
		{ID: "m3", DMChannelID: "c1", UserID: "alice"},
		{ID: "m2", DMChannelID: "c1", UserID: "bob"},
		{ID: "m1", DMChannelID: "c1", UserID: "alice"},
	}
	repo.delivered = map[string]bool{"m1": true}

	page, err := svc.GetMessages(context.Background(), "alice", "c1", "", 50)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}

	if repo.deliveredAsked != "bob" {
		t.Fatalf("asked about %q's watermark, want the other participant's", repo.deliveredAsked)
	}
	byID := map[string]*bool{}
	for _, m := range page.Messages {
		byID[m.ID] = m.Delivered
	}
	if byID["m1"] == nil || !*byID["m1"] {
		t.Error("own delivered message m1 not marked delivered")
	}
	if byID["m3"] == nil || *byID["m3"] {
		t.Error("own undelivered message m3 should say delivered=false")
	}
	if byID["m2"] != nil {
		t.Error("the other participant's message carries a delivery flag")
	}
}

// One request covers every conversation the app learned has news; one it is not in — or that is
// gone — is skipped rather than failing the rest.
func TestMarkDeliveredLatest_SkipsConversationsTheUserIsNotIn(t *testing.T) {
	svc, repo, hub := deliveryService(true)

	if err := svc.MarkDeliveredLatest(context.Background(), "bob", []string{"gone", "c1"}); err != nil {
		t.Fatalf("MarkDeliveredLatest: %v", err)
	}
	if repo.markCalls != 1 || len(hub.eventsFor("alice", ws.OpDMDelivered)) != 1 {
		t.Fatalf("%d marks, %d events to the sender; want one each", repo.markCalls, len(hub.eventsFor("alice", ws.OpDMDelivered)))
	}

	repo.markCalls = 0
	if err := svc.MarkDeliveredLatest(context.Background(), "mallory", []string{"c1"}); err != nil {
		t.Fatalf("a stranger's report: %v", err)
	}
	if repo.markCalls != 0 {
		t.Fatal("a stranger's report was stored")
	}
}
