package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// errReachedPersistence marks the point past every policy gate. A test that sees it knows the
// request was allowed through; a test that expected a refusal knows the gate is gone.
var errReachedPersistence = errors.New("reached persistence")

// policyDMRepo answers the reads SendMessage and EditMessage make before they write, and records
// whether either write was attempted.
type policyDMRepo struct {
	repository.DMRepository

	channel *models.DMChannel
	message *models.DMMessage

	created int
	updated int
}

func (r *policyDMRepo) GetChannelByID(context.Context, string) (*models.DMChannel, error) {
	return r.channel, nil
}

func (r *policyDMRepo) GetMessageByID(context.Context, string) (*models.DMMessage, error) {
	return r.message, nil
}

func (r *policyDMRepo) CreateMessage(context.Context, *models.DMMessage) error {
	r.created++
	return errReachedPersistence
}

func (r *policyDMRepo) UpdateMessage(context.Context, string, *models.UpdateDMMessageRequest) error {
	r.updated++
	return errReachedPersistence
}

// policyUserRepo keeps the recipient lookups between the policy gate and the write from panicking.
type policyUserRepo struct {
	repository.UserRepository
}

func (r *policyUserRepo) GetActiveByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id}, nil
}

func (r *policyUserRepo) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id}, nil
}

func policyDMService(e2ee bool) (*dmService, *policyDMRepo) {
	repo := &policyDMRepo{
		channel: &models.DMChannel{
			ID: "c1", User1ID: "alice", User2ID: "bob",
			Status:      models.DMStatusAccepted,
			E2EEEnabled: e2ee,
		},
		message: &models.DMMessage{ID: "m1", DMChannelID: "c1", UserID: "alice"},
	}
	// friendChecker and blockChecker left nil on purpose: both are nil-guarded, so the request
	// reaches the write without the privacy rules getting a vote.
	return &dmService{dmRepo: repo, userRepo: &policyUserRepo{}}, repo
}

// The rule is one rule, and it has to be enforced where the request actually arrives — not merely
// implemented. It shipped on the channel create path and not on the channel edit path, and the same
// two DM paths had no test driving them at all: deleting either enforcement line left every test
// green. These drive SendMessage and EditMessage themselves, so a missing call site fails here.
func TestDMEncryptionPolicy_IsEnforcedOnSendAndEdit(t *testing.T) {
	cases := []struct {
		name     string
		e2ee     bool
		version  int
		wantCode string // "" means the message must be allowed through to the write
	}{
		{"plaintext in a plaintext conversation", false, 0, ""},
		{"encrypted in an encrypted conversation", true, 1, ""},
		{"plaintext in an encrypted conversation", true, 0, pkg.CodeEncryptionRequired},
		{"encrypted in a plaintext conversation", false, 1, pkg.CodeEncryptionNotAvailable},
	}

	for _, tc := range cases {
		t.Run("send/"+tc.name, func(t *testing.T) {
			svc, repo := policyDMService(tc.e2ee)

			_, err := svc.SendMessage(context.Background(), "alice", "c1", &models.CreateDMMessageRequest{
				Content:           "hello",
				EncryptionVersion: tc.version,
				Ciphertext:        encryptedField(tc.version, "CIPHER"),
				SenderDeviceID:    encryptedField(tc.version, "dev1"),
			})

			assertPolicyAtCallSite(t, err, tc.wantCode, repo.created, "the message was written")
		})

		t.Run("edit/"+tc.name, func(t *testing.T) {
			svc, repo := policyDMService(tc.e2ee)

			_, err := svc.EditMessage(context.Background(), "alice", "m1", &models.UpdateDMMessageRequest{
				Content:           "edited",
				EncryptionVersion: tc.version,
				Ciphertext:        encryptedField(tc.version, "CIPHER"),
				SenderDeviceID:    encryptedField(tc.version, "dev1"),
			})

			assertPolicyAtCallSite(t, err, tc.wantCode, repo.updated, "the edit was written")
		})
	}
}

// encryptedField supplies the fields Validate demands of an encrypted request, and nothing for a
// plaintext one — a plaintext request carrying a ciphertext would be rejected by validation instead
// of by the policy, and prove nothing.
func encryptedField(version int, value string) *string {
	if version != 1 {
		return nil
	}
	return &value
}

func assertPolicyAtCallSite(t *testing.T, err error, wantCode string, writes int, wroteMsg string) {
	t.Helper()

	if wantCode == "" {
		if !errors.Is(err, errReachedPersistence) {
			t.Fatalf("a message that matches the conversation was refused: %v", err)
		}
		if writes != 1 {
			t.Errorf("%s %d times, want 1", wroteMsg, writes)
		}
		return
	}

	if errors.Is(err, errReachedPersistence) {
		t.Fatalf("the policy did not run at this call site — %s despite the mismatch", wroteMsg)
	}
	if err == nil {
		t.Fatal("expected the message to be refused, got nil")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("want ErrBadRequest, got %v", err)
	}
	if got := pkg.CodeOf(err); got != wantCode {
		t.Errorf("code = %q, want %q — the client maps this to the reason it shows", got, wantCode)
	}
	if writes != 0 {
		t.Errorf("%s anyway (%d times)", wroteMsg, writes)
	}
}
