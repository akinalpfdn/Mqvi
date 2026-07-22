package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

// Some columns are settings; these are security state. A write that assigns the field on the struct
// but leaves the column out of the UPDATE fails silently — the request succeeds, the response shows
// the new value, and the database keeps the old one. The service layer above this is tested against
// the stored state, so it would enforce the stale answer and look correct doing it.

// e2ee_enabled decides whether the server refuses plaintext or refuses ciphertext. If an update
// stops persisting it, turning encryption on appears to work and every later message is judged
// against the old setting.
func TestServerUpdate_PersistsTheEncryptionFlag(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteServerRepo(f.DB)
	ctx := context.Background()

	id := f.Server(dbtest.ServerSeed{E2EEEnabled: false})

	server, err := repo.GetByID(ctx, id)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if server.E2EEEnabled {
		t.Fatal("the fixture seeded an unencrypted server but it reads as encrypted")
	}

	server.E2EEEnabled = true
	if err := repo.Update(ctx, server); err != nil {
		t.Fatalf("update: %v", err)
	}

	reloaded, err := repo.GetByID(ctx, id)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !reloaded.E2EEEnabled {
		t.Error("encryption was switched on and the row still says off — every message after this is judged against the old setting")
	}

	// And back off again: a one-way write would pass the check above.
	reloaded.E2EEEnabled = false
	if err := repo.Update(ctx, reloaded); err != nil {
		t.Fatalf("update back: %v", err)
	}
	final, err := repo.GetByID(ctx, id)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if final.E2EEEnabled {
		t.Error("encryption was switched off and the row still says on")
	}
}

// A role's permissions are a bitfield, and the update is the only way they change. Dropping the
// column from the write leaves every member holding whatever they were granted the day the role
// was created, while the UI shows the edit as applied.
func TestRoleUpdate_PersistsPermissions(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteRoleRepo(f.DB)
	ctx := context.Background()

	serverID := f.Server(dbtest.ServerSeed{})
	role := &models.Role{
		ServerID:    serverID,
		Name:        "Moderator",
		Color:       "#ff0000",
		Position:    2,
		Permissions: models.PermReadMessages,
		Mentionable: true,
	}
	if err := repo.Create(ctx, role); err != nil {
		t.Fatalf("create: %v", err)
	}

	role.Permissions = models.PermReadMessages | models.PermManageMessages
	role.Name = "Senior Moderator"
	role.Mentionable = false
	if err := repo.Update(ctx, role); err != nil {
		t.Fatalf("update: %v", err)
	}

	got, err := repo.GetByID(ctx, role.ID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	want := models.PermReadMessages | models.PermManageMessages
	if got.Permissions != want {
		t.Errorf("permissions = %d, want %d — the grant was accepted and never stored", got.Permissions, want)
	}
	if got.Name != "Senior Moderator" {
		t.Errorf("name = %q, want the edited value", got.Name)
	}
	if got.Mentionable {
		t.Error("mentionable stayed true after being turned off")
	}
}

// The default role is @everyone. Deleting it would leave every member with no baseline permissions
// and no way to get them back, so the guard lives in the DELETE itself rather than above it.
func TestRoleDelete_RefusesTheDefaultRole(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteRoleRepo(f.DB)
	ctx := context.Background()

	serverID := f.Server(dbtest.ServerSeed{})
	everyone := &models.Role{ServerID: serverID, Name: "@everyone", Position: 1, IsDefault: true}
	if err := repo.Create(ctx, everyone); err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := repo.Delete(ctx, everyone.ID); err == nil {
		t.Error("the default role was deleted — every member loses their baseline permissions")
	}

	if _, err := repo.GetByID(ctx, everyone.ID); err != nil {
		t.Errorf("the default role is gone after a delete that should have refused: %v", err)
	}
}
