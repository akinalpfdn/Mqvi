package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/testutil"
)

// Routes carry the server id, and the resource id comes from the same URL. Nothing in the routing
// ties the two together: a member of server A can address server A's route with server B's channel,
// role or category id and, without this guard, act on it with A's permissions. Every service checks
// it — nineteen hand-written copies of the same three lines — and none of them was tested.
//
// Each case below asks a method to act on a resource that belongs to "server-B" while claiming to
// be on "server-A", and expects a refusal. Deleting any one guard turns exactly one case red.
const (
	routeServer   = "server-A"
	foreignServer = "server-B"
)

// channelOn returns a channel repo whose lookup always answers with a channel owned by another
// server — the shape of the attack, not of a mistake.
func channelOn(serverID string) *testutil.MockChannelRepo {
	return &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: serverID, Type: models.ChannelTypeText}, nil
		},
	}
}

func roleOn(serverID string) *testutil.MockRoleRepo {
	return &testutil.MockRoleRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Role, error) {
			return &models.Role{ID: id, ServerID: serverID}, nil
		},
	}
}

func TestCrossServerOwnership_ForeignResourcesAreRefused(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		name string
		call func() error
	}{
		{"role update", func() error {
			s := &roleService{roleRepo: roleOn(foreignServer)}
			_, err := s.Update(ctx, routeServer, "actor", "role-1", &models.UpdateRoleRequest{Name: testutil.Ptr("x")})
			return err
		}},
		{"role delete", func() error {
			s := &roleService{roleRepo: roleOn(foreignServer)}
			return s.Delete(ctx, routeServer, "actor", "role-1")
		}},
		{"channel update", func() error {
			s := &channelService{channelRepo: channelOn(foreignServer)}
			_, err := s.Update(ctx, routeServer, "channel-1", &models.UpdateChannelRequest{})
			return err
		}},
		{"channel delete", func() error {
			s := &channelService{channelRepo: channelOn(foreignServer)}
			return s.Delete(ctx, routeServer, "channel-1")
		}},
		{"channel overrides read", func() error {
			s := &channelPermService{channelGetter: channelOn(foreignServer)}
			_, err := s.GetOverrides(ctx, routeServer, "channel-1")
			return err
		}},
		{"channel override write", func() error {
			s := &channelPermService{channelGetter: channelOn(foreignServer)}
			return s.SetOverride(ctx, routeServer, "channel-1", "role-1", &models.SetOverrideRequest{Allow: models.PermReadMessages})
		}},
		{"channel override delete", func() error {
			s := &channelPermService{channelGetter: channelOn(foreignServer)}
			return s.DeleteOverride(ctx, routeServer, "channel-1", "role-1")
		}},
		{"pin", func() error {
			s := &pinService{
				messageRepo: &testutil.MockMessageRepo{
					GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
						return &models.Message{ID: id, ChannelID: "channel-1"}, nil
					},
				},
				channelRepo: channelOn(foreignServer),
			}
			_, err := s.Pin(ctx, routeServer, "message-1", "channel-1", "actor")
			return err
		}},
		{"unpin", func() error {
			s := &pinService{
				messageRepo: &testutil.MockMessageRepo{
					GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
						return &models.Message{ID: id, ChannelID: "channel-1"}, nil
					},
				},
				channelRepo: channelOn(foreignServer),
			}
			return s.Unpin(ctx, routeServer, "message-1", "channel-1")
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+" on a foreign server is refused", func(t *testing.T) {
			err := tc.call()

			if err == nil {
				t.Fatal("a resource from another server was acted on through this server's route")
			}
			if !errors.Is(err, pkg.ErrForbidden) {
				t.Errorf("got %v, want ErrForbidden — the caller must not learn whether the id exists", err)
			}
			// The refusal has to be THIS one. Several of these methods have other Forbidden paths
			// further down — a role hierarchy check, a permission check — and any of them would
			// satisfy an errors.Is on its own. Deleting the ownership guard then leaves the test
			// green while the hole is open, which is exactly what happened before this line existed.
			if !strings.Contains(err.Error(), "does not belong to this server") {
				t.Errorf(
					"refused with %q, but not by the ownership guard — some later check happened to say no, "+
						"so this case does not pin the guard it names", err,
				)
			}
		})
	}
}

// The same guard must not refuse the ordinary case, or the check is just a broken endpoint.
func TestCrossServerOwnership_OwnResourcesArePermitted(t *testing.T) {
	ctx := context.Background()

	t.Run("a channel on this server passes the ownership gate", func(t *testing.T) {
		s := &channelPermService{
			channelGetter: channelOn(routeServer),
			permRepo: &testutil.MockChannelPermRepo{
				GetByChannelFn: func(_ context.Context, _ string) ([]models.ChannelPermissionOverride, error) {
					return []models.ChannelPermissionOverride{}, nil
				},
			},
		}

		if _, err := s.GetOverrides(ctx, routeServer, "channel-1"); err != nil {
			t.Errorf("the gate refused a channel that does belong to this server: %v", err)
		}
	})
}
