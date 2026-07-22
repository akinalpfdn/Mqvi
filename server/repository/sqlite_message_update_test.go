package repository

import (
	"context"
	"database/sql"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

// An encrypted edit has to persist the new ciphertext. Writing only `content` left the old
// ciphertext in the row, so the client decrypted the original text and the edit vanished — the user
// saw "(edited)" beside unchanged words.
func TestMessageUpdate_PersistsCiphertextOnEncryptedEdit(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteMessageRepo(f.DB)

	id := f.Message(dbtest.MessageSeed{
		EncryptionVersion: 1,
		Ciphertext:        dbtest.Ptr("OLD-CIPHER"),
		SenderDeviceID:    dbtest.Ptr("dev1"),
	})

	err := repo.Update(context.Background(), &models.Message{
		ID:                id,
		EncryptionVersion: 1,
		Ciphertext:        dbtest.Ptr("NEW-CIPHER"),
		SenderDeviceID:    dbtest.Ptr("dev2"),
		E2EEMetadata:      dbtest.Ptr(`{"v":2}`),
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	var ciphertext, deviceID, metadata string
	var content sql.NullString
	var editedAt sql.NullTime
	if err := f.DB.QueryRow(
		`SELECT ciphertext, sender_device_id, e2ee_metadata, content, edited_at FROM messages WHERE id = ?`, id,
	).Scan(&ciphertext, &deviceID, &metadata, &content, &editedAt); err != nil {
		t.Fatalf("read back: %v", err)
	}

	if ciphertext != "NEW-CIPHER" {
		t.Errorf("ciphertext = %q, want the edited value — the edit was silently discarded", ciphertext)
	}
	if deviceID != "dev2" {
		t.Errorf("sender_device_id = %q, want dev2", deviceID)
	}
	if metadata != `{"v":2}` {
		t.Errorf("e2ee_metadata = %q, want the edited value", metadata)
	}
	if content.Valid {
		t.Errorf("content = %q, want NULL so no plaintext sits beside the ciphertext", content.String)
	}
	if !editedAt.Valid {
		t.Error("edited_at should be stamped")
	}
}

func TestMessageUpdate_PersistsContentOnPlaintextEdit(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteMessageRepo(f.DB)

	id := f.Message(dbtest.MessageSeed{Content: dbtest.Ptr("before")})

	if err := repo.Update(context.Background(), &models.Message{
		ID:                id,
		EncryptionVersion: 0,
		Content:           dbtest.Ptr("after"),
	}); err != nil {
		t.Fatalf("update: %v", err)
	}

	var content string
	if err := f.DB.QueryRow(`SELECT content FROM messages WHERE id = ?`, id).Scan(&content); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if content != "after" {
		t.Errorf("content = %q, want after", content)
	}
}

// A server can toggle E2EE between a message being written and being edited, so the stored version
// and the edit's version disagree. Branching on the stored one nulled the content of a plaintext
// message without saving any ciphertext — the text was gone for good.
func TestMessageUpdate_EncryptionVersionTransitions(t *testing.T) {
	t.Run("should convert a plaintext row to encrypted when E2EE was switched on", func(t *testing.T) {
		f := dbtest.New(t)
		repo := NewSQLiteMessageRepo(f.DB)
		id := f.Message(dbtest.MessageSeed{Content: dbtest.Ptr("original text")})

		if err := repo.Update(context.Background(), &models.Message{
			ID:                id,
			EncryptionVersion: 1,
			Ciphertext:        dbtest.Ptr("CIPHER"),
			SenderDeviceID:    dbtest.Ptr("dev1"),
			E2EEMetadata:      dbtest.Ptr("{}"),
		}); err != nil {
			t.Fatalf("update: %v", err)
		}

		var version int
		var ciphertext, content sql.NullString
		if err := f.DB.QueryRow(
			`SELECT encryption_version, ciphertext, content FROM messages WHERE id = ?`, id,
		).Scan(&version, &ciphertext, &content); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if version != 1 {
			t.Errorf("encryption_version = %d, want 1 — the row must follow the edit", version)
		}
		if ciphertext.String != "CIPHER" {
			t.Errorf("ciphertext = %q, want CIPHER — the edit was dropped and the text lost", ciphertext.String)
		}
		if content.Valid {
			t.Errorf("content = %q, want NULL", content.String)
		}
	})

	t.Run("should convert an encrypted row to plaintext when E2EE was switched off", func(t *testing.T) {
		f := dbtest.New(t)
		repo := NewSQLiteMessageRepo(f.DB)
		id := f.Message(dbtest.MessageSeed{
			EncryptionVersion: 1,
			Ciphertext:        dbtest.Ptr("OLD-CIPHER"),
			SenderDeviceID:    dbtest.Ptr("dev1"),
		})

		if err := repo.Update(context.Background(), &models.Message{
			ID:                id,
			EncryptionVersion: 0,
			Content:           dbtest.Ptr("now in the clear"),
		}); err != nil {
			t.Fatalf("update: %v", err)
		}

		var version int
		var content string
		var ciphertext sql.NullString
		if err := f.DB.QueryRow(
			`SELECT encryption_version, content, ciphertext FROM messages WHERE id = ?`, id,
		).Scan(&version, &content, &ciphertext); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if version != 0 {
			t.Errorf("encryption_version = %d, want 0", version)
		}
		if content != "now in the clear" {
			t.Errorf("content = %q, want the edited text — the edit was swallowed", content)
		}
		if ciphertext.Valid {
			t.Errorf("ciphertext = %q, want NULL so the row cannot disagree with its version", ciphertext.String)
		}
	})
}
