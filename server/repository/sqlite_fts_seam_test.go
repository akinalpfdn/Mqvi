package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

// The search index is maintained by triggers declared `AFTER UPDATE OF content`, which fire only
// when `content` appears in the statement's SET list. That makes the repository's UPDATE and the
// trigger a single mechanism split across two files: drop `content = NULL` from the encrypted
// branch as a redundant-looking assignment and the trigger stops firing, leaving the old plaintext
// in the index. The row then reads as encrypted while its words are still returned by search.
//
// Neither side proved this on its own. The migration test writes its own UPDATE by hand, and the
// repository tests only read columns back. These drive the repository and then ask the index.
func TestMessageUpdate_KeepsTheSearchIndexInStepWithEncryption(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteMessageRepo(f.DB)
	ctx := context.Background()

	id := f.Message(dbtest.MessageSeed{Content: dbtest.Ptr("findable plaintext")})
	if n := ftsCount(t, f, "messages_fts", "findable"); n != 1 {
		t.Fatalf("a plaintext message is not searchable to begin with (%d matches)", n)
	}

	// Plaintext -> encrypted: the words must leave the index with the text.
	if err := repo.Update(ctx, &models.Message{
		ID:                id,
		EncryptionVersion: 1,
		Ciphertext:        dbtest.Ptr("CIPHER"),
		SenderDeviceID:    dbtest.Ptr("dev1"),
	}); err != nil {
		t.Fatalf("update to encrypted: %v", err)
	}
	if n := ftsCount(t, f, "messages_fts", "findable"); n != 0 {
		t.Errorf(
			"the old plaintext is still in the search index after the message was encrypted (%d matches) — "+
				"search returns words the row no longer stores", n,
		)
	}

	// Encrypted -> plaintext: the new words must enter the index, or the message is unsearchable
	// for good with no client-side fallback once E2EE is off.
	if err := repo.Update(ctx, &models.Message{
		ID:                id,
		EncryptionVersion: 0,
		Content:           dbtest.Ptr("readable again"),
	}); err != nil {
		t.Fatalf("update to plaintext: %v", err)
	}
	if n := ftsCount(t, f, "messages_fts", "readable"); n != 1 {
		t.Errorf("a message turned back to plaintext is not searchable (%d matches)", n)
	}
}

// The DM repository carries the same split across the same two files, with its own triggers.
func TestDMMessageUpdate_KeepsTheSearchIndexInStepWithEncryption(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteDMRepo(f.DB)
	ctx := context.Background()

	id := f.DMMessage(dbtest.DMMessageSeed{Content: dbtest.Ptr("findable plaintext")})
	if n := ftsCount(t, f, "dm_messages_fts", "findable"); n != 1 {
		t.Fatalf("a plaintext DM is not searchable to begin with (%d matches)", n)
	}

	if err := repo.UpdateMessage(ctx, id, &models.UpdateDMMessageRequest{
		EncryptionVersion: 1,
		Ciphertext:        dbtest.Ptr("CIPHER"),
		SenderDeviceID:    dbtest.Ptr("dev1"),
	}); err != nil {
		t.Fatalf("update to encrypted: %v", err)
	}
	if n := ftsCount(t, f, "dm_messages_fts", "findable"); n != 0 {
		t.Errorf("the old plaintext is still in the DM search index after encryption (%d matches)", n)
	}

	if err := repo.UpdateMessage(ctx, id, &models.UpdateDMMessageRequest{
		EncryptionVersion: 0,
		Content:           "readable again",
	}); err != nil {
		t.Fatalf("update to plaintext: %v", err)
	}
	if n := ftsCount(t, f, "dm_messages_fts", "readable"); n != 1 {
		t.Errorf("a DM turned back to plaintext is not searchable (%d matches)", n)
	}
}

func ftsCount(t *testing.T, f *dbtest.Fixture, table, term string) int {
	t.Helper()
	var n int
	// The table name is a constant from the caller, never user input.
	if err := f.DB.QueryRow(
		`SELECT count(*) FROM `+table+` WHERE `+table+` MATCH ?`, term,
	).Scan(&n); err != nil {
		t.Fatalf("search %s for %q: %v", table, term, err)
	}
	return n
}
