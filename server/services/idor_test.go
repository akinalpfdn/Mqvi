package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/testutil"
)

// Cross-server authorization (IDOR) regression tests for Phase 40. Each proves that an
// object belonging to another server cannot be acted on via a different server's route.

func foreignChannelRepo() *testutil.MockChannelRepo {
	return &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "chan-1", ServerID: "other-srv"}, nil
		},
	}
}

func TestGetOverrides_CrossServerDenied(t *testing.T) {
	svc := newTestChannelPermService(
		&testutil.MockChannelPermRepo{},
		&testutil.MockRoleRepo{},
		foreignChannelRepo(),
		&testutil.MockBroadcaster{},
	)

	_, err := svc.GetOverrides(context.Background(), "srv-1", "chan-1")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("cross-server override list should be forbidden, got %v", err)
	}
}

func TestSetOverride_CrossServerDenied(t *testing.T) {
	svc := newTestChannelPermService(
		&testutil.MockChannelPermRepo{},
		&testutil.MockRoleRepo{},
		foreignChannelRepo(),
		&testutil.MockBroadcaster{},
	)

	err := svc.SetOverride(context.Background(), "srv-1", "chan-1", "role-1",
		&models.SetOverrideRequest{Allow: models.PermSendMessages})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("cross-server SetOverride should be forbidden, got %v", err)
	}
}

func TestToggleReaction_UnauthorizedDenied(t *testing.T) {
	// Actor has no permissions on the message's channel (cross-server, or a channel they
	// cannot view) — the reaction must be rejected BEFORE it is persisted.
	toggled := false
	svc := NewReactionService(
		&testutil.MockReactionRepo{
			ToggleFn: func(_ context.Context, _, _, _ string) (bool, error) {
				toggled = true
				return true, nil
			},
		},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		&testutil.MockChannelRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return 0, nil // no permissions on the channel
			},
		},
	)

	err := svc.ToggleReaction(context.Background(), "m1", "attacker", "👍")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("unauthorized reaction should be forbidden, got %v", err)
	}
	if toggled {
		t.Error("reaction must NOT be persisted when the actor is unauthorized")
	}
}

func TestRoleReorder_CrossServerDenied(t *testing.T) {
	// Even an owner (who bypasses the position checks) must be blocked from reordering a
	// role in another server — the ServerID assert runs before the isOwner short-circuit.
	svc := NewRoleService(
		&testutil.MockRoleRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Role, error) {
				return &models.Role{ID: "role-1", ServerID: "other-srv"}, nil
			},
			GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
				return []models.Role{{ID: "owner", IsOwner: true, Position: 100}}, nil
			},
		},
		&testutil.MockUserRepo{},
		&testutil.MockBroadcaster{},
	)

	_, err := svc.ReorderRoles(context.Background(), "srv-1", "actor",
		[]models.PositionUpdate{{ID: "role-1", Position: 0}})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("cross-server role reorder should be forbidden, got %v", err)
	}
}

func TestRoleDelete_CrossServerDenied(t *testing.T) {
	svc := NewRoleService(
		&testutil.MockRoleRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Role, error) {
				return &models.Role{ID: "role-1", ServerID: "other-srv"}, nil
			},
		},
		&testutil.MockUserRepo{},
		&testutil.MockBroadcaster{},
	)

	err := svc.Delete(context.Background(), "srv-1", "actor", "role-1")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("cross-server role delete should be forbidden, got %v", err)
	}
}

// Phase 48-A #1 — the role-assignment path (ModifyRoles) is a distinct endpoint from
// role update/delete/reorder above; it must ALSO reject a role from another server, or its
// permission bits (Admin on a position-0 role) leak into the target's effective perms.
func TestModifyRoles_ForeignRoleRejected(t *testing.T) {
	assigned := false
	svc := &memberService{
		roleRepo: &testutil.MockRoleRepo{
			GetByUserIDAndServerFn: func(_ context.Context, userID, _ string) ([]models.Role, error) {
				if userID == "actor" {
					return []models.Role{{ID: "actor-role", Position: 100}}, nil
				}
				return []models.Role{{ID: "target-role", Position: 10}}, nil // target, not owner
			},
			GetByIDFn: func(_ context.Context, _ string) (*models.Role, error) {
				// A low-position role in ANOTHER server carrying Admin perms.
				return &models.Role{ID: "foreign", ServerID: "other-srv", Position: 0, Permissions: models.PermAdmin}, nil
			},
			AssignToUserFn: func(_ context.Context, _, _, _ string) error {
				assigned = true
				return nil
			},
		},
	}

	_, err := svc.ModifyRoles(context.Background(), "srv-1", "actor", "target", []string{"foreign"})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("assigning a foreign-server role should be forbidden, got %v", err)
	}
	if assigned {
		t.Error("a foreign role must NOT be assigned (privilege escalation vector)")
	}
}

// Phase 48-A #4 — E2EE group-session access resolves the actor against the channel's OWN
// server, so a non-member (0 perms — e.g. probing another server's channel by ID) is denied,
// while a member who can view + read is allowed.
func TestE2EEGroupSession_AuthorizeChannelAccess(t *testing.T) {
	denySvc := &e2eeService{
		permResolver: &testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return 0, nil // outsider / cross-server → no permissions
			},
		},
	}
	if err := denySvc.authorizeChannelAccess(context.Background(), "outsider", "chan-B"); !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("outsider should be denied group-session access, got %v", err)
	}

	allowSvc := &e2eeService{
		permResolver: &testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermViewChannel | models.PermReadMessages, nil
			},
		},
	}
	if err := allowSvc.authorizeChannelAccess(context.Background(), "member", "chan-A"); err != nil {
		t.Errorf("a member with view+read should be allowed, got %v", err)
	}
}
