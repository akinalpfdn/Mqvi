package services

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
)

// ledger records every reserve and release so a test can assert the two sides balance. Quota is a
// running counter, not a computed sum, so anything charged and never given back is a permanent
// overcount on a real account.
type ledger struct {
	reserved int64
	released int64
}

func (l *ledger) service() *testutil.MockStorageService {
	return &testutil.MockStorageService{
		ReserveFn: func(_ context.Context, _ string, b int64) error { l.reserved += b; return nil },
		ReleaseFn: func(_ context.Context, _ string, b int64) error { l.released += b; return nil },
	}
}

// net is what the user is actually charged once the dust settles.
func (l *ledger) net() int64 { return l.reserved - l.released }

// Deleting a message has to hand back exactly what its attachments were charged — the original and
// the thumbnail. The thumbnail was charged at upload only after 086, and the release had to follow
// it; a comment in the delete path still claimed thumbnails carried no quota.
func TestQuotaLedger_DeleteReleasesBothOriginalAndThumbnail(t *testing.T) {
	fileSize := int64(4096)
	thumbSize := int64(256)
	l := &ledger{}

	svc := NewMessageService(
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
				return &models.Message{ID: id, ChannelID: "ch1", UserID: "u1"}, nil
			},
		},
		&testutil.MockAttachmentRepo{
			GetByMessageIDFn: func(_ context.Context, _ string) ([]models.Attachment, error) {
				return []models.Attachment{{
					ID: "a1", FileURL: "/u/f.bin", FileSize: &fileSize,
					ThumbURL: testutilPtr("/u/f_t.webp"), ThumbSize: &thumbSize,
				}}, nil
			},
		},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "s1"}, nil
			},
		}, &testutil.MockUserRepo{},
		&testutil.MockMentionRepo{}, &testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{}, &testutil.MockReactionRepo{}, &testutil.MockReadStateRepo{},
		&testutil.MockBroadcastAndOnline{}, &testutil.MockChannelPermResolver{},
		&testutil.MockFileURLSigner{}, &testutil.MockFileDeleter{},
		l.service(), stubServerEncryption{},
	)

	// The upload charged both; deleting must give both back.
	l.reserved = fileSize + thumbSize

	if err := svc.Delete(context.Background(), "s1", "m1", "u1", models.PermManageMessages); err != nil {
		t.Fatalf("delete: %v", err)
	}

	if l.net() != 0 {
		t.Errorf(
			"quota did not settle: charged %d, released %d, leaving %d owed forever",
			l.reserved, l.released, l.net(),
		)
	}
}

// Deleting an attachment that never had a preview must not release bytes nobody was charged.
func TestQuotaLedger_DeleteWithoutThumbnailReleasesOnlyTheFile(t *testing.T) {
	fileSize := int64(4096)
	l := &ledger{reserved: fileSize}

	svc := NewMessageService(
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
				return &models.Message{ID: id, ChannelID: "ch1", UserID: "u1"}, nil
			},
		},
		&testutil.MockAttachmentRepo{
			GetByMessageIDFn: func(_ context.Context, _ string) ([]models.Attachment, error) {
				return []models.Attachment{{ID: "a1", FileURL: "/u/f.bin", FileSize: &fileSize}}, nil
			},
		},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "s1"}, nil
			},
		}, &testutil.MockUserRepo{},
		&testutil.MockMentionRepo{}, &testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{}, &testutil.MockReactionRepo{}, &testutil.MockReadStateRepo{},
		&testutil.MockBroadcastAndOnline{}, &testutil.MockChannelPermResolver{},
		&testutil.MockFileURLSigner{}, &testutil.MockFileDeleter{},
		l.service(), stubServerEncryption{},
	)

	if err := svc.Delete(context.Background(), "s1", "m1", "u1", models.PermManageMessages); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if l.released != fileSize {
		t.Errorf("released %d, want %d — releasing more than was charged credits the user", l.released, fileSize)
	}
}

func testutilPtr(s string) *string { return &s }
