package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// blockDMRepo holds one conversation between alice and bob with one message from alice, and
// counts every write so a test can tell an action was refused before it touched anything.
type blockDMRepo struct {
	repository.DMRepository
	writes int
}

var blockTestChannel = models.DMChannel{ID: "c1", User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}

func (r *blockDMRepo) GetChannelByID(context.Context, string) (*models.DMChannel, error) {
	c := blockTestChannel
	return &c, nil
}

func (r *blockDMRepo) GetChannelByUsers(context.Context, string, string) (*models.DMChannel, error) {
	return nil, nil
}

func (r *blockDMRepo) GetMessageByID(context.Context, string) (*models.DMMessage, error) {
	return &models.DMMessage{ID: "m1", DMChannelID: "c1", UserID: "alice"}, nil
}

func (r *blockDMRepo) CreateChannel(context.Context, *models.DMChannel) error {
	r.writes++
	return nil
}

func (r *blockDMRepo) UpdateMessage(context.Context, string, *models.UpdateDMMessageRequest) error {
	r.writes++
	return nil
}

func (r *blockDMRepo) ToggleReaction(context.Context, string, string, string) (bool, error) {
	r.writes++
	return true, nil
}

func (r *blockDMRepo) GetReactionsByMessageID(context.Context, string) ([]models.ReactionGroup, error) {
	return nil, nil
}

func (r *blockDMRepo) PinMessage(context.Context, string) error {
	r.writes++
	return nil
}

func (r *blockDMRepo) UnpinMessage(context.Context, string) error {
	r.writes++
	return nil
}

func (r *blockDMRepo) GetAttachmentsByMessageIDs(context.Context, []string) (map[string][]models.DMAttachment, error) {
	return nil, nil
}

func (r *blockDMRepo) GetReactionsByMessageIDs(context.Context, []string) (map[string][]models.ReactionGroup, error) {
	return nil, nil
}

type blockDMUsers struct {
	repository.UserRepository
	admins map[string]bool
}

func (u *blockDMUsers) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id, IsPlatformAdmin: u.admins[id]}, nil
}

func (u *blockDMUsers) GetActiveByID(ctx context.Context, id string) (*models.User, error) {
	return u.GetByID(ctx, id)
}

type fixedBlock struct{ blocked bool }

func (b fixedBlock) IsBlocked(context.Context, string, string) (bool, error) { return b.blocked, nil }

func blockDMService(blocked bool, admins ...string) (*dmService, *blockDMRepo, *recordingHub) {
	repo := &blockDMRepo{}
	hub := &recordingHub{}
	users := &blockDMUsers{admins: map[string]bool{}}
	for _, a := range admins {
		users.admins[a] = true
	}
	return &dmService{
		dmRepo:       repo,
		userRepo:     users,
		hub:          hub,
		blockChecker: fixedBlock{blocked: blocked},
		urlSigner:    fakeURLSigner{},
	}, repo, hub
}

// Every way alice can reach bob inside DMs, besides sending, which has its own tests.
var dmBlockActions = []struct {
	name string
	act  func(s *dmService) error
}{
	{"edit an old message", func(s *dmService) error {
		_, err := s.EditMessage(context.Background(), "alice", "m1", &models.UpdateDMMessageRequest{Content: "changed"})
		return err
	}},
	{"react", func(s *dmService) error { return s.ToggleReaction(context.Background(), "alice", "m1", "👍") }},
	{"pin", func(s *dmService) error { return s.PinMessage(context.Background(), "alice", "m1") }},
	{"unpin", func(s *dmService) error { return s.UnpinMessage(context.Background(), "alice", "m1") }},
	{"show typing", func(s *dmService) error {
		_, err := s.TypingRecipient(context.Background(), "alice", "c1")
		return err
	}},
	{"open a new conversation", func(s *dmService) error {
		_, err := s.GetOrCreateChannel(context.Background(), "alice", "bob")
		return err
	}},
}

func TestDMActions_RefusedAcrossABlock(t *testing.T) {
	for _, tc := range dmBlockActions {
		t.Run(tc.name, func(t *testing.T) {
			svc, repo, hub := blockDMService(true)

			err := tc.act(svc)

			if !errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("want ErrForbidden across a block, got %v", err)
			}
			if repo.writes != 0 || len(hub.sent) != 0 {
				t.Fatalf("refused action still wrote %d rows and sent %d events", repo.writes, len(hub.sent))
			}
		})
	}
}

func TestDMActions_PlatformAdminIsExemptFromTheBlock(t *testing.T) {
	for _, tc := range dmBlockActions {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, _ := blockDMService(true, "alice")

			if err := tc.act(svc); errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("platform admin was refused: %v", err)
			}
		})
	}
}

func TestTypingRecipient_IsTheOtherSideWithoutABlock(t *testing.T) {
	svc, _, _ := blockDMService(false)

	got, err := svc.TypingRecipient(context.Background(), "alice", "c1")

	if err != nil || got != "bob" {
		t.Fatalf("want bob, got %q err=%v", got, err)
	}
}
