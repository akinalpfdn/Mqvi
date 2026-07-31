package services

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"
)

// GetAll had no service-level coverage at all, which is how the 2N+1 went unnoticed from the day
// it was written. These pin the output contract the roster change had to preserve, not the query
// shape.

type rosterSigner struct{}

func (rosterSigner) SignURL(u string) string { return u + "?signed" }
func (rosterSigner) SignURLPtr(u *string) *string {
	if u == nil {
		return nil
	}
	signed := *u + "?signed"
	return &signed
}

// Embedded nil interfaces: GetAll must not touch the ban repo, the server repo or the hub, and a
// nil-method panic is a louder way to find out than a silent extra query.
type rosterBanRepo struct{ repository.BanRepository }
type rosterServerRepo struct{ repository.ServerRepository }
type rosterHub struct{ ws.BroadcastAndManage }

func rosterService(users []models.User, roles map[string][]models.Role) MemberService {
	userRepo := &testutil.MockUserRepo{
		GetServerMembersFn: func(context.Context, string) ([]models.User, error) { return users, nil },
	}
	roleRepo := &testutil.MockRoleRepo{
		GetByServerGroupedByUserFn: func(context.Context, string) (map[string][]models.Role, error) {
			return roles, nil
		},
	}
	return NewMemberService(
		userRepo, roleRepo, rosterBanRepo{}, rosterServerRepo{},
		rosterHub{}, nil, nil, rosterSigner{},
	)
}

func TestGetAll_AttachesEachMembersOwnRolesAndFoldsPermissions(t *testing.T) {
	avatar := "/api/files/avatars/u1/a.png"
	users := []models.User{
		{ID: "u1", Username: "alpha", AvatarURL: &avatar},
		{ID: "u2", Username: "bravo"},
	}
	roles := map[string][]models.Role{
		"u1": {
			{ID: "r-admin", Permissions: models.PermManageMessages},
			{ID: "r-base", Permissions: models.PermSendMessages},
		},
	}

	members, err := rosterService(users, roles).GetAll(context.Background(), "s1")
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("got %d members, want 2", len(members))
	}

	if len(members[0].Roles) != 2 {
		t.Fatalf("u1 got %d roles, want 2", len(members[0].Roles))
	}
	want := models.PermManageMessages | models.PermSendMessages
	if members[0].EffectivePermissions != want {
		t.Fatalf("effective perms %d, want %d", members[0].EffectivePermissions, want)
	}

	// A member with no assignments must come back with an empty slice, not null — the frontend
	// iterates it unconditionally.
	if members[1].Roles == nil {
		t.Fatal("u2 roles is nil; ToMemberWithRoles must normalise to an empty slice")
	}
	if len(members[1].Roles) != 0 {
		t.Fatalf("u2 got %d roles, want 0 — another member's roles leaked", len(members[1].Roles))
	}
}

// Every avatar leaving the server is signed. Batching the roles must not have skipped the signer
// for anyone.
func TestGetAll_SignsEveryAvatar(t *testing.T) {
	a1 := "/api/files/avatars/u1/a.png"
	a2 := "/api/files/avatars/u2/b.png"
	users := []models.User{
		{ID: "u1", Username: "alpha", AvatarURL: &a1},
		{ID: "u2", Username: "bravo", AvatarURL: &a2},
		{ID: "u3", Username: "charlie"},
	}

	members, err := rosterService(users, nil).GetAll(context.Background(), "s1")
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}

	for _, m := range members {
		if m.AvatarURL == nil {
			continue // no avatar set — nothing to sign
		}
		if *m.AvatarURL != "/api/files/avatars/"+m.ID+"/"+map[string]string{"u1": "a.png", "u2": "b.png"}[m.ID]+"?signed" {
			t.Fatalf("%s avatar not signed: %q", m.ID, *m.AvatarURL)
		}
	}
}

func TestGetAll_ReturnsEmptySliceForAnEmptyServer(t *testing.T) {
	members, err := rosterService(nil, nil).GetAll(context.Background(), "s1")
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	// Not nil: the handler serialises this straight to JSON and null breaks the client's iteration.
	if members == nil {
		t.Fatal("got nil, want an empty slice")
	}
	if len(members) != 0 {
		t.Fatalf("got %d members, want 0", len(members))
	}
}
