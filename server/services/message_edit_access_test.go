package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/testutil"
)

// editFixture: message m1 by u1 in channel ch1 of server srv1. perms is what u1 resolves to in ch1.
func editFixture(perms models.Permission, permErr error) (MessageService, *testutil.MockMessageRepo, *bool) {
	updated := false
	msgRepo := &testutil.MockMessageRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
			return &models.Message{ID: id, ChannelID: "ch1", UserID: "u1"}, nil
		},
		UpdateFn: func(_ context.Context, _ *models.Message) error {
			updated = true
			return nil
		},
	}
	svc := newTestMessageService(
		msgRepo,
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{
			GetByUsernameFn: func(context.Context, string) (*models.User, error) { return nil, pkg.ErrNotFound },
		},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, userID, channelID string) (models.Permission, error) {
				if userID != "u1" || channelID != "ch1" {
					return 0, nil
				}
				return perms, permErr
			},
		},
	)
	return svc, msgRepo, &updated
}

func TestMessageEdit_KickedAuthorCannotRewriteOldMessages(t *testing.T) {
	// Kick/ban deletes the user's roles, so their permissions in the channel resolve to nothing.
	svc, _, updated := editFixture(0, nil)

	// They still belong to another server and use its route — the membership check passes there.
	_, err := svc.Update(context.Background(), "srv1", "m1", "u1", &models.UpdateMessageRequest{Content: "defaced"})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden for an author who lost access to the channel", err)
	}
	if *updated {
		t.Fatal("the message row was written for an author with no access")
	}
}

func TestMessageEdit_RouteOfAnotherServerIsRefused(t *testing.T) {
	svc, _, updated := editFixture(models.PermSendMessages|models.PermReadMessages|models.PermViewChannel, nil)

	_, err := svc.Update(context.Background(), "my-own-server", "m1", "u1", &models.UpdateMessageRequest{Content: "x"})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden when the message is not in the route's server", err)
	}
	if *updated {
		t.Fatal("the message row was written through another server's route")
	}
}

func TestMessageEdit_SendRevokedAuthorIsRefused(t *testing.T) {
	// Still a member who can read, but the channel was made read-only for them.
	svc, _, updated := editFixture(models.PermReadMessages|models.PermViewChannel, nil)

	_, err := svc.Update(context.Background(), "srv1", "m1", "u1", &models.UpdateMessageRequest{Content: "x"})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden without SendMessages", err)
	}
	if *updated {
		t.Fatal("the message row was written without SendMessages")
	}
}

func TestMessageEdit_PermissionResolveErrorFailsClosed(t *testing.T) {
	svc, _, updated := editFixture(0, errors.New("db down"))

	if _, err := svc.Update(context.Background(), "srv1", "m1", "u1", &models.UpdateMessageRequest{Content: "x"}); err == nil {
		t.Fatal("an unresolvable permission let the edit through")
	}
	if *updated {
		t.Fatal("the message row was written although permissions could not be resolved")
	}
}

func TestMessageEdit_AuthorWithSendPermissionCanEdit(t *testing.T) {
	svc, _, updated := editFixture(models.PermSendMessages|models.PermReadMessages|models.PermViewChannel, nil)

	msg, err := svc.Update(context.Background(), "srv1", "m1", "u1", &models.UpdateMessageRequest{Content: "fixed typo"})
	if err != nil {
		t.Fatalf("a normal edit failed: %v", err)
	}
	if !*updated || msg.Content == nil || *msg.Content != "fixed typo" {
		t.Fatalf("edit not applied: updated=%v msg=%+v", *updated, msg)
	}
}
