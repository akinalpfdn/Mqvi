package repository

import (
	"context"
	"database/sql"
	"testing"

	"github.com/akinalp/mqvi/models"
	_ "modernc.org/sqlite"
)

func newMessageUpdateTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			content TEXT,
			edited_at DATETIME,
			encryption_version INTEGER NOT NULL DEFAULT 0,
			ciphertext TEXT,
			sender_device_id TEXT,
			e2ee_metadata TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return db
}

func ptr(s string) *string { return &s }

// An encrypted edit has to persist the new ciphertext. Writing only `content` left the old
// ciphertext in the row, so the client decrypted the original text and the edit vanished — the user
// saw "(edited)" beside unchanged words.
func TestMessageUpdate_PersistsCiphertextOnEncryptedEdit(t *testing.T) {
	db := newMessageUpdateTestDB(t)
	repo := NewSQLiteMessageRepo(db)

	if _, err := db.Exec(
		`INSERT INTO messages (id, channel_id, user_id, encryption_version, ciphertext, sender_device_id, e2ee_metadata)
		 VALUES ('m1', 'ch1', 'u1', 1, 'OLD-CIPHER', 'dev1', '{}')`,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}

	err := repo.Update(context.Background(), &models.Message{
		ID:                "m1",
		EncryptionVersion: 1,
		Ciphertext:        ptr("NEW-CIPHER"),
		SenderDeviceID:    ptr("dev2"),
		E2EEMetadata:      ptr(`{"v":2}`),
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	var ciphertext, deviceID, metadata string
	var content sql.NullString
	var editedAt sql.NullTime
	if err := db.QueryRow(
		`SELECT ciphertext, sender_device_id, e2ee_metadata, content, edited_at FROM messages WHERE id = 'm1'`,
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
	db := newMessageUpdateTestDB(t)
	repo := NewSQLiteMessageRepo(db)

	if _, err := db.Exec(
		`INSERT INTO messages (id, channel_id, user_id, content, encryption_version)
		 VALUES ('m1', 'ch1', 'u1', 'before', 0)`,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := repo.Update(context.Background(), &models.Message{
		ID:                "m1",
		EncryptionVersion: 0,
		Content:           ptr("after"),
	}); err != nil {
		t.Fatalf("update: %v", err)
	}

	var content string
	if err := db.QueryRow(`SELECT content FROM messages WHERE id = 'm1'`).Scan(&content); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if content != "after" {
		t.Errorf("content = %q, want after", content)
	}
}
