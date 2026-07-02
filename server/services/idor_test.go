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
