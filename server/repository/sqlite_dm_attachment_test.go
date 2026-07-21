package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

// The DM side carries the same columns through a separate INSERT and SELECT, so it drifts from the
// channel side independently — which is how the DM path kept missing a fix the channel path had.
func TestDMAttachment_CreateRoundTrip(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteDMRepo(f.DB)
	ctx := context.Background()

	msgID := f.DMMessage(dbtest.DMMessageSeed{Content: dbtest.Ptr("with a photo")})
	size := int64(4096)
	thumbSize := int64(120)
	w, h := 640, 480

	att := &models.DMAttachment{
		DMMessageID: msgID,
		Filename:    "photo.jpg",
		FileURL:     "/api/files/dms/d1/photo.jpg",
		FileSize:    &size,
		MimeType:    dbtest.Ptr("image/jpeg"),
		ThumbURL:    dbtest.Ptr("/api/files/dms/d1/photo_thumb.webp"),
		ThumbWidth:  &w,
		ThumbHeight: &h,
		ThumbSize:   &thumbSize,
	}
	if err := repo.CreateAttachment(ctx, att); err != nil {
		t.Fatalf("create: %v", err)
	}
	if att.ID == "" {
		t.Fatal("CreateAttachment must populate the generated id")
	}

	byMsg, err := repo.GetAttachmentsByMessageIDs(ctx, []string{msgID})
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	got := byMsg[msgID]
	if len(got) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(got))
	}
	a := got[0]

	if a.Filename != att.Filename || a.FileURL != att.FileURL {
		t.Errorf("identity fields differ: %+v", a)
	}
	assertInt64Ptr(t, "file_size", a.FileSize, att.FileSize)
	assertStrPtr(t, "mime_type", a.MimeType, att.MimeType)
	assertStrPtr(t, "thumb_url", a.ThumbURL, att.ThumbURL)
	assertIntPtr(t, "thumb_width", a.ThumbWidth, att.ThumbWidth)
	assertIntPtr(t, "thumb_height", a.ThumbHeight, att.ThumbHeight)
	assertInt64Ptr(t, "thumb_size", a.ThumbSize, att.ThumbSize)
}

func TestDMAttachment_WithoutThumbnail(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteDMRepo(f.DB)
	ctx := context.Background()

	msgID := f.DMMessage(dbtest.DMMessageSeed{Content: dbtest.Ptr("a document")})
	if err := repo.CreateAttachment(ctx, &models.DMAttachment{
		DMMessageID: msgID, Filename: "notes.pdf", FileURL: "/u/notes.pdf",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	byMsg, err := repo.GetAttachmentsByMessageIDs(ctx, []string{msgID})
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	a := byMsg[msgID][0]
	if a.ThumbURL != nil || a.ThumbWidth != nil || a.ThumbHeight != nil || a.ThumbSize != nil {
		t.Errorf("thumbnail columns must stay nil, got %+v", a)
	}
}

// A DM edit writes through a request struct rather than a model, so its branches are its own. The
// version has to follow the edit, or the row ends up claiming one thing and holding another.
func TestDMMessageUpdate_EncryptionVersionTransitions(t *testing.T) {
	ctx := context.Background()

	t.Run("plaintext row becomes encrypted", func(t *testing.T) {
		f := dbtest.New(t)
		repo := NewSQLiteDMRepo(f.DB)
		id := f.DMMessage(dbtest.DMMessageSeed{Content: dbtest.Ptr("original")})

		if err := repo.UpdateMessage(ctx, id, &models.UpdateDMMessageRequest{
			EncryptionVersion: 1,
			Ciphertext:        dbtest.Ptr("CIPHER"),
			SenderDeviceID:    dbtest.Ptr("d1"),
			E2EEMetadata:      dbtest.Ptr("{}"),
		}); err != nil {
			t.Fatalf("update: %v", err)
		}

		var version int
		var content, ciphertext *string
		if err := f.DB.QueryRow(
			`SELECT encryption_version, content, ciphertext FROM dm_messages WHERE id = ?`, id,
		).Scan(&version, &content, &ciphertext); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if version != 1 {
			t.Errorf("encryption_version = %d, want 1", version)
		}
		if content != nil {
			t.Errorf("content = %q, want NULL — plaintext must not sit beside the ciphertext", *content)
		}
		if ciphertext == nil || *ciphertext != "CIPHER" {
			t.Error("the new ciphertext was not persisted")
		}
	})

	t.Run("encrypted row becomes plaintext", func(t *testing.T) {
		f := dbtest.New(t)
		repo := NewSQLiteDMRepo(f.DB)
		id := f.DMMessage(dbtest.DMMessageSeed{
			EncryptionVersion: 1, Ciphertext: dbtest.Ptr("OLD"), SenderDeviceID: dbtest.Ptr("d1"),
		})

		if err := repo.UpdateMessage(ctx, id, &models.UpdateDMMessageRequest{
			EncryptionVersion: 0, Content: "now readable",
		}); err != nil {
			t.Fatalf("update: %v", err)
		}

		var version int
		var content, ciphertext *string
		if err := f.DB.QueryRow(
			`SELECT encryption_version, content, ciphertext FROM dm_messages WHERE id = ?`, id,
		).Scan(&version, &content, &ciphertext); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if version != 0 {
			t.Errorf("encryption_version = %d, want 0", version)
		}
		if content == nil || *content != "now readable" {
			t.Error("the edit was swallowed")
		}
		if ciphertext != nil {
			t.Errorf("ciphertext = %q, want NULL so the row cannot disagree with its version", *ciphertext)
		}
	})
}
