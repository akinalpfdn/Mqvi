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

// nonceMessageRepo is a message repo whose nonce index starts with `stored` (nonce → id, channel).
type nonceMessageRepo struct {
	*testutil.MockMessageRepo
	created int
}

func newNonceSvc(t *testing.T, stored map[string][2]string, perms models.Permission, createErr error) (MessageService, *nonceMessageRepo) {
	t.Helper()
	repo := &nonceMessageRepo{}
	repo.MockMessageRepo = &testutil.MockMessageRepo{
		GetByAuthorNonceFn: func(_ context.Context, _ string, nonce string) (string, string, error) {
			if hit, ok := stored[nonce]; ok {
				return hit[0], hit[1], nil
			}
			return "", "", pkg.ErrNotFound
		},
		GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
			return &models.Message{ID: id, ChannelID: "ch1", UserID: "u1", Content: ptr("first send")}, nil
		},
		CreateFn: func(_ context.Context, m *models.Message) error {
			repo.created++
			if createErr != nil {
				return createErr
			}
			m.ID = "new"
			return nil
		},
	}
	svc := newTestMessageService(
		repo.MockMessageRepo,
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		}},
		&testutil.MockUserRepo{
			GetByIDFn:       func(context.Context, string) (*models.User, error) { return &models.User{ID: "u1"}, nil },
			GetByUsernameFn: func(context.Context, string) (*models.User, error) { return nil, pkg.ErrNotFound },
		},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
			return perms, nil
		}},
	)
	return svc, repo
}

func ptr(s string) *string { return &s }

const sendPerms = models.PermSendMessages | models.PermReadMessages

func TestMessageCreate_ClientNonce(t *testing.T) {
	ctx := context.Background()

	t.Run("a retry returns the stored message and creates nothing, even after losing the permission", func(t *testing.T) {
		svc, repo := newNonceSvc(t, map[string][2]string{"nonce-0001": {"m9", "ch1"}}, 0, nil)

		msg, repeat, err := svc.Create(ctx, "ch1", "u1", &models.CreateMessageRequest{Content: "first send", ClientNonce: "nonce-0001"})

		if err != nil || !repeat || msg.ID != "m9" {
			t.Fatalf("got (%v, repeat=%v, %v), want the stored m9 as a repeat", msg, repeat, err)
		}
		if msg.ClientNonce == nil || *msg.ClientNonce != "nonce-0001" {
			t.Fatalf("client_nonce = %v, want echoed", msg.ClientNonce)
		}
		if msg.Attachments == nil || msg.Reactions == nil {
			t.Fatal("the stored message must come back enriched like a fresh one")
		}
		if repo.created != 0 {
			t.Fatalf("created %d messages, want 0", repo.created)
		}
	})

	t.Run("a nonce used for another channel is refused", func(t *testing.T) {
		svc, repo := newNonceSvc(t, map[string][2]string{"nonce-0001": {"m9", "other"}}, sendPerms, nil)

		_, _, err := svc.Create(ctx, "ch1", "u1", &models.CreateMessageRequest{Content: "hi", ClientNonce: "nonce-0001"})

		if !errors.Is(err, pkg.ErrConflict) || repo.created != 0 {
			t.Fatalf("err = %v, created %d; want ErrConflict and nothing created", err, repo.created)
		}
	})

	t.Run("the copy that loses an insert race returns the winner's message", func(t *testing.T) {
		stored := map[string][2]string{}
		svc, repo := newNonceSvc(t, stored, sendPerms, nil)
		repo.CreateFn = func(_ context.Context, _ *models.Message) error {
			repo.created++
			stored["nonce-race-1"] = [2]string{"winner", "ch1"} // the other copy committed first
			return repository.ErrDuplicateClientNonce
		}

		msg, repeat, err := svc.Create(ctx, "ch1", "u1", &models.CreateMessageRequest{Content: "hi", ClientNonce: "nonce-race-1"})

		if err != nil || !repeat || msg.ID != "winner" {
			t.Fatalf("got (%v, repeat=%v, %v), want the winner as a repeat", msg, repeat, err)
		}
	})

	t.Run("a new nonce creates the message and carries the nonce", func(t *testing.T) {
		svc, repo := newNonceSvc(t, nil, sendPerms, nil)
		var written *string
		repo.CreateFn = func(_ context.Context, m *models.Message) error {
			repo.created++
			written = m.ClientNonce
			m.ID = "new"
			return nil
		}

		msg, repeat, err := svc.Create(ctx, "ch1", "u1", &models.CreateMessageRequest{Content: "hi", ClientNonce: "nonce-fresh"})

		if err != nil || repeat || msg.ID != "new" || repo.created != 1 {
			t.Fatalf("got (%v, repeat=%v, %v), created %d; want one new message", msg, repeat, err, repo.created)
		}
		if written == nil || *written != "nonce-fresh" {
			t.Fatalf("nonce written = %v, want nonce-fresh", written)
		}
	})

	t.Run("a malformed nonce is a bad request", func(t *testing.T) {
		svc, repo := newNonceSvc(t, nil, sendPerms, nil)

		_, _, err := svc.Create(ctx, "ch1", "u1", &models.CreateMessageRequest{Content: "hi", ClientNonce: "bad nonce!"})

		if !errors.Is(err, pkg.ErrBadRequest) || repo.created != 0 {
			t.Fatalf("err = %v, created %d; want ErrBadRequest", err, repo.created)
		}
	})
}
