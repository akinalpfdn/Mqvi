package repository

import (
	"context"
	"fmt"
	"testing"

	"github.com/akinalp/mqvi/testutil/dbtest"
)

func insertRole(f *dbtest.Fixture, id, serverID string, position int) {
	f.ExecWithoutForeignKeys(
		`INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
		 VALUES (?, ?, ?, '#fff', ?, 0, 0, 0, 1)`, id, serverID, id, position)
}

func assignRole(f *dbtest.Fixture, userID, roleID, serverID string) {
	f.ExecWithoutForeignKeys(`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, userID, roleID, serverID)
}

// Voice audience resolution folds these slices into effective permissions, so they must be exactly
// what the per-user query returns — same roles, same order — and nothing from another server.
func TestGetByUsersAndServer_MatchesThePerUserQuery(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteRoleRepo(f.DB)

	serverID := f.Server(dbtest.ServerSeed{})
	other := f.Server(dbtest.ServerSeed{})
	asked := f.User("asked")
	notAsked := f.User("not-asked")

	insertRole(f, "r-low", serverID, 1)
	insertRole(f, "r-high", serverID, 9)
	insertRole(f, "r-elsewhere", other, 5)
	assignRole(f, asked, "r-low", serverID)
	assignRole(f, asked, "r-high", serverID)
	assignRole(f, asked, "r-elsewhere", other)
	assignRole(f, notAsked, "r-high", serverID)

	got, err := repo.GetByUsersAndServer(ctx, serverID, []string{asked})
	if err != nil {
		t.Fatalf("GetByUsersAndServer: %v", err)
	}
	perUser, err := repo.GetByUserIDAndServer(ctx, asked, serverID)
	if err != nil {
		t.Fatalf("GetByUserIDAndServer: %v", err)
	}

	if _, ok := got[notAsked]; ok {
		t.Fatal("returned roles for a user that was not asked for")
	}
	if len(got[asked]) != len(perUser) || len(perUser) != 2 {
		t.Fatalf("got %d roles, per-user query %d, want 2 (the other server's role excluded)", len(got[asked]), len(perUser))
	}
	for i := range perUser {
		if got[asked][i].ID != perUser[i].ID {
			t.Fatalf("order differs at %d: got %q, per-user %q", i, got[asked][i].ID, perUser[i].ID)
		}
	}
}

// An online audience can be larger than one IN list; every user past the chunk boundary still counts.
func TestGetByUsersAndServer_CoversEveryChunk(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteRoleRepo(f.DB)

	serverID := f.Server(dbtest.ServerSeed{})
	insertRole(f, "r-member", serverID, 1)

	users := make([]string, roleUserChunk+3)
	for i := range users {
		users[i] = f.User(fmt.Sprintf("u%04d", i))
		assignRole(f, users[i], "r-member", serverID)
	}

	got, err := repo.GetByUsersAndServer(ctx, serverID, users)
	if err != nil {
		t.Fatalf("GetByUsersAndServer: %v", err)
	}
	for _, id := range users {
		if len(got[id]) != 1 {
			t.Fatalf("user %s has %d roles, want 1 — a chunk was skipped", id, len(got[id]))
		}
	}
}

func TestGetByUsersAndServer_NoUsersNoQuery(t *testing.T) {
	f := dbtest.New(t)
	got, err := NewSQLiteRoleRepo(f.DB).GetByUsersAndServer(context.Background(), f.Server(dbtest.ServerSeed{}), nil)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v; want empty, nil", got, err)
	}
}
