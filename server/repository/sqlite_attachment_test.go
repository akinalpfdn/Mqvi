package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

// Every field the model declares has to survive the round trip. Assigning one on the struct and
// leaving it out of the INSERT is invisible to the compiler and to any test that only checks the
// returned struct — the thumbnail columns went in three separate rounds, one column at a time.
func TestAttachment_CreateRoundTrip(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteAttachmentRepo(f.DB)
	ctx := context.Background()

	msgID := f.Message(dbtest.MessageSeed{Content: dbtest.Ptr("with a photo")})
	size := int64(2048)
	thumbSize := int64(96)
	w, h := 800, 600

	att := &models.Attachment{
		MessageID:   msgID,
		Filename:    "photo.jpg",
		FileURL:     "/api/files/messages/c1/photo.jpg",
		FileSize:    &size,
		MimeType:    dbtest.Ptr("image/jpeg"),
		ThumbURL:    dbtest.Ptr("/api/files/messages/c1/photo_thumb.webp"),
		ThumbWidth:  &w,
		ThumbHeight: &h,
		ThumbSize:   &thumbSize,
	}
	if err := repo.Create(ctx, att); err != nil {
		t.Fatalf("create: %v", err)
	}
	if att.ID == "" {
		t.Fatal("Create must populate the generated id")
	}
	if att.CreatedAt.IsZero() {
		t.Error("Create must populate created_at")
	}

	got, err := repo.GetByMessageID(ctx, msgID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(got))
	}
	assertAttachmentMatches(t, got[0], att)
}

// The batch read is a separate SELECT with its own column list, so it can drift from the single-row
// one — a column added to one and not the other loses the field for every message list in the app.
func TestAttachment_GetByMessageIDsMatchesSingleRead(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteAttachmentRepo(f.DB)
	ctx := context.Background()

	msgID := f.Message(dbtest.MessageSeed{Content: dbtest.Ptr("x")})
	size := int64(10)
	thumbSize := int64(5)
	w, h := 4, 3
	att := &models.Attachment{
		MessageID: msgID, Filename: "f.png", FileURL: "/u/f.png",
		FileSize: &size, MimeType: dbtest.Ptr("image/png"),
		ThumbURL: dbtest.Ptr("/u/f_t.png"), ThumbWidth: &w, ThumbHeight: &h, ThumbSize: &thumbSize,
	}
	if err := repo.Create(ctx, att); err != nil {
		t.Fatalf("create: %v", err)
	}

	single, err := repo.GetByMessageID(ctx, msgID)
	if err != nil {
		t.Fatalf("single read: %v", err)
	}
	batch, err := repo.GetByMessageIDs(ctx, []string{msgID})
	if err != nil {
		t.Fatalf("batch read: %v", err)
	}
	if len(batch) != 1 {
		t.Fatalf("expected 1 attachment from the batch read, got %d", len(batch))
	}
	assertAttachmentMatches(t, batch[0], att)
	assertAttachmentMatches(t, batch[0], &single[0])
}

// An attachment with no preview is the normal case for a document, and the nil columns have to come
// back nil rather than as a zero that the client would read as a real size.
func TestAttachment_WithoutThumbnail(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteAttachmentRepo(f.DB)
	ctx := context.Background()

	msgID := f.Message(dbtest.MessageSeed{Content: dbtest.Ptr("a document")})
	att := &models.Attachment{MessageID: msgID, Filename: "notes.pdf", FileURL: "/u/notes.pdf"}
	if err := repo.Create(ctx, att); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.GetByMessageID(ctx, msgID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	a := got[0]
	if a.ThumbURL != nil || a.ThumbWidth != nil || a.ThumbHeight != nil || a.ThumbSize != nil {
		t.Errorf("thumbnail columns must stay nil, got %+v", a)
	}
	if a.FileSize != nil || a.MimeType != nil {
		t.Errorf("unset optional columns must stay nil, got %+v", a)
	}
}

// Deleting a message takes its attachments with it. The rows own files and quota, so a cascade that
// silently stopped working would leave both behind with nothing pointing at them.
func TestAttachment_CascadesWithItsMessage(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteAttachmentRepo(f.DB)
	ctx := context.Background()

	msgID := f.Message(dbtest.MessageSeed{Content: dbtest.Ptr("x")})
	if err := repo.Create(ctx, &models.Attachment{
		MessageID: msgID, Filename: "f.bin", FileURL: "/u/f.bin",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := f.DB.Exec(`DELETE FROM messages WHERE id = ?`, msgID); err != nil {
		t.Fatalf("delete message: %v", err)
	}

	var n int
	if err := f.DB.QueryRow(`SELECT count(*) FROM attachments WHERE message_id = ?`, msgID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("attachments left behind after the message was deleted: %d", n)
	}
}

func assertAttachmentMatches(t *testing.T, got models.Attachment, want *models.Attachment) {
	t.Helper()
	if got.Filename != want.Filename {
		t.Errorf("filename = %q, want %q", got.Filename, want.Filename)
	}
	if got.FileURL != want.FileURL {
		t.Errorf("file_url = %q, want %q", got.FileURL, want.FileURL)
	}
	assertInt64Ptr(t, "file_size", got.FileSize, want.FileSize)
	assertStrPtr(t, "mime_type", got.MimeType, want.MimeType)
	assertStrPtr(t, "thumb_url", got.ThumbURL, want.ThumbURL)
	assertIntPtr(t, "thumb_width", got.ThumbWidth, want.ThumbWidth)
	assertIntPtr(t, "thumb_height", got.ThumbHeight, want.ThumbHeight)
	assertInt64Ptr(t, "thumb_size", got.ThumbSize, want.ThumbSize)
}

func assertStrPtr(t *testing.T, field string, got, want *string) {
	t.Helper()
	switch {
	case got == nil && want == nil:
	case got == nil || want == nil:
		t.Errorf("%s: got %v, want %v — the column did not survive the round trip", field, got, want)
	case *got != *want:
		t.Errorf("%s = %q, want %q", field, *got, *want)
	}
}

func assertIntPtr(t *testing.T, field string, got, want *int) {
	t.Helper()
	switch {
	case got == nil && want == nil:
	case got == nil || want == nil:
		t.Errorf("%s: got %v, want %v — the column did not survive the round trip", field, got, want)
	case *got != *want:
		t.Errorf("%s = %d, want %d", field, *got, *want)
	}
}

func assertInt64Ptr(t *testing.T, field string, got, want *int64) {
	t.Helper()
	switch {
	case got == nil && want == nil:
	case got == nil || want == nil:
		t.Errorf("%s: got %v, want %v — the column did not survive the round trip", field, got, want)
	case *got != *want:
		t.Errorf("%s = %d, want %d", field, *got, *want)
	}
}
