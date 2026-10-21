package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
)

// nonceDMRepo holds a conversation in the state the first send of a message request leaves it in:
// pending, initiated by alice, with her message stored under its nonce.
type nonceDMRepo struct {
	repository.DMRepository
	channel  *models.DMChannel
	stored   map[string][2]string // nonce → message id, channel id
	created  int
	createFn func() error
}

func (r *nonceDMRepo) GetChannelByID(context.Context, string) (*models.DMChannel, error) {
	return r.channel, nil
}

func (r *nonceDMRepo) GetMessageByAuthorNonce(_ context.Context, _ string, nonce string) (string, string, error) {
	if hit, ok := r.stored[nonce]; ok {
		return hit[0], hit[1], nil
	}
	return "", "", pkg.ErrNotFound
}

func (r *nonceDMRepo) GetMessageByID(_ context.Context, id string) (*models.DMMessage, error) {
	return &models.DMMessage{ID: id, DMChannelID: "c1", UserID: "alice", Content: ptr("hello")}, nil
}

func (r *nonceDMRepo) GetAttachmentsByMessageIDs(context.Context, []string) (map[string][]models.DMAttachment, error) {
	return nil, nil
}

func (r *nonceDMRepo) GetReactionsByMessageIDs(context.Context, []string) (map[string][]models.ReactionGroup, error) {
	return nil, nil
}

func (r *nonceDMRepo) CreateMessage(context.Context, *models.DMMessage) error {
	r.created++
	if r.createFn != nil {
		return r.createFn()
	}
	return errReachedPersistence
}

func pendingRequestDMService() (*dmService, *nonceDMRepo) {
	alice := "alice"
	repo := &nonceDMRepo{
		channel: &models.DMChannel{
			ID: "c1", User1ID: "alice", User2ID: "bob",
			Status: models.DMStatusPending, InitiatedBy: &alice,
		},
		stored: map[string][2]string{"nonce-req-01": {"m1", "c1"}},
	}
	return &dmService{dmRepo: repo, userRepo: &policyUserRepo{}, urlSigner: &testutil.MockFileURLSigner{}}, repo
}

// A first message turns a conversation into a pending request, and "the initiator already sent
// their one message" then refuses every further send. The retry of that very message must not be
// one of them: it was stored, so it is answered with what was stored.
func TestDMSend_RetryOfARequestsFirstMessageIsNotRefused(t *testing.T) {
	ctx := context.Background()

	t.Run("without a nonce the pending request refuses a second send", func(t *testing.T) {
		svc, repo := pendingRequestDMService()

		_, _, err := svc.SendMessage(ctx, "alice", "c1", &models.CreateDMMessageRequest{Content: "hello"})

		if !errors.Is(err, pkg.ErrForbidden) || repo.created != 0 {
			t.Fatalf("err = %v, created %d; want ErrForbidden — the gate this test relies on", err, repo.created)
		}
	})

	t.Run("the retry with the first send's nonce gets the stored message", func(t *testing.T) {
		svc, repo := pendingRequestDMService()

		msg, repeat, err := svc.SendMessage(ctx, "alice", "c1", &models.CreateDMMessageRequest{Content: "hello", ClientNonce: "nonce-req-01"})

		if err != nil || !repeat || msg.ID != "m1" || repo.created != 0 {
			t.Fatalf("got (%v, repeat=%v, %v), created %d; want the stored m1, nothing created", msg, repeat, err, repo.created)
		}
		if msg.ClientNonce == nil || *msg.ClientNonce != "nonce-req-01" || msg.Attachments == nil {
			t.Fatalf("stored message must come back enriched with its nonce: %+v", msg)
		}
	})

	t.Run("a nonce used in another conversation is refused", func(t *testing.T) {
		svc, repo := pendingRequestDMService()
		repo.stored["nonce-req-01"] = [2]string{"m1", "other"}

		_, _, err := svc.SendMessage(ctx, "alice", "c1", &models.CreateDMMessageRequest{Content: "hello", ClientNonce: "nonce-req-01"})

		if !errors.Is(err, pkg.ErrConflict) {
			t.Fatalf("err = %v, want ErrConflict", err)
		}
	})
}

func TestDMSend_TheCopyThatLosesTheInsertRaceReturnsTheWinner(t *testing.T) {
	svc, repo := policyDMServiceWithNonce()
	repo.createFn = func() error {
		repo.stored["nonce-race-dm"] = [2]string{"winner", "c1"}
		return repository.ErrDuplicateClientNonce
	}

	msg, repeat, err := svc.SendMessage(context.Background(), "alice", "c1", &models.CreateDMMessageRequest{Content: "hello", ClientNonce: "nonce-race-dm"})

	if err != nil || !repeat || msg.ID != "winner" {
		t.Fatalf("got (%v, repeat=%v, %v), want the winner as a repeat", msg, repeat, err)
	}
}

// policyDMServiceWithNonce is an accepted conversation with an empty nonce index.
func policyDMServiceWithNonce() (*dmService, *nonceDMRepo) {
	repo := &nonceDMRepo{
		channel: &models.DMChannel{ID: "c1", User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted},
		stored:  map[string][2]string{},
	}
	return &dmService{dmRepo: repo, userRepo: &policyUserRepo{}, urlSigner: &testutil.MockFileURLSigner{}}, repo
}
