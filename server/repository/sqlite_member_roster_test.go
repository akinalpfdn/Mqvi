package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/testutil/dbtest"
)

// The roster used to be built by loading every platform user and asking IsMember about each one.
// These run against the real migrations, because the whole point of the change is which rows the
// database returns — a mocked repository would assert nothing.

func TestGetServerMembers_ScopesToTheServerAndSkipsDeleted(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteUserRepo(f.DB)

	serverID := f.Server(dbtest.ServerSeed{})
	other := f.Server(dbtest.ServerSeed{})

	member := f.User("bravo")
	alsoMember := f.User("alpha")
	deletedMember := f.User("charlie")
	strangerOnAnotherServer := f.User("delta")

	for _, id := range []string{member, alsoMember, deletedMember} {
		f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, serverID, id)
	}
	f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, other, strangerOnAnotherServer)
	f.ExecWithoutForeignKeys(`UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`, deletedMember)

	got, err := repo.GetServerMembers(ctx, serverID)
	if err != nil {
		t.Fatalf("GetServerMembers: %v", err)
	}

	ids := make([]string, 0, len(got))
	for _, u := range got {
		ids = append(ids, u.ID)
	}
	if len(ids) != 2 {
		t.Fatalf("got %d members %v, want 2 (the deleted one and the other server's are excluded)", len(ids), ids)
	}

	// Ordered by username, which the old implementation inherited from GetAll's ORDER BY and the
	// member list still relies on.
	if got[0].Username > got[1].Username {
		t.Fatalf("not ordered by username: %q then %q", got[0].Username, got[1].Username)
	}
}

// A roster renders nine fields. Reading a password hash to render none of them is a leak waiting
// for the first handler that forgets to strip it.
func TestGetServerMembers_DoesNotReadPasswordHash(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteUserRepo(f.DB)

	serverID := f.Server(dbtest.ServerSeed{})
	userID := f.User("someone")
	f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, serverID, userID)
	f.ExecWithoutForeignKeys(`UPDATE users SET password_hash = 'secret-hash' WHERE id = ?`, userID)

	got, err := repo.GetServerMembers(ctx, serverID)
	if err != nil {
		t.Fatalf("GetServerMembers: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d members, want 1", len(got))
	}
	if got[0].PasswordHash != "" {
		t.Fatalf("password hash left the database: %q", got[0].PasswordHash)
	}
}

func TestGetByServerGroupedByUser_MatchesThePerUserQuery(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	roleRepo := NewSQLiteRoleRepo(f.DB)

	serverID := f.Server(dbtest.ServerSeed{})
	otherServer := f.Server(dbtest.ServerSeed{})
	userID := f.User("holder")

	f.ExecWithoutForeignKeys(
		`INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
		 VALUES ('r-low', ?, 'low', '#fff', 1, 0, 0, 0, 1)`, serverID)
	f.ExecWithoutForeignKeys(
		`INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
		 VALUES ('r-high', ?, 'high', '#fff', 9, 0, 0, 0, 1)`, serverID)
	f.ExecWithoutForeignKeys(
		`INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
		 VALUES ('r-elsewhere', ?, 'elsewhere', '#fff', 5, 0, 0, 0, 1)`, otherServer)

	for _, roleID := range []string{"r-low", "r-high"} {
		f.ExecWithoutForeignKeys(`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, userID, roleID, serverID)
	}
	f.ExecWithoutForeignKeys(`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, userID, "r-elsewhere", otherServer)

	grouped, err := roleRepo.GetByServerGroupedByUser(ctx, serverID)
	if err != nil {
		t.Fatalf("GetByServerGroupedByUser: %v", err)
	}
	perUser, err := roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		t.Fatalf("GetByUserIDAndServer: %v", err)
	}

	// Byte-identical to what the roster used to build per user: same roles, same
	// position-descending order. The effective-permission fold and the name colour both read it.
	if len(grouped[userID]) != len(perUser) {
		t.Fatalf("grouped %d roles, per-user query %d", len(grouped[userID]), len(perUser))
	}
	for i := range perUser {
		if grouped[userID][i].ID != perUser[i].ID {
			t.Fatalf("order differs at %d: grouped %q, per-user %q", i, grouped[userID][i].ID, perUser[i].ID)
		}
	}
	if len(perUser) == 0 || perUser[0].ID != "r-high" {
		t.Fatalf("expected highest position first, got %+v", perUser)
	}
}

