package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
)

// helper to create the service with mocks wired up.
func newTestChannelPermService(
	permRepo *testutil.MockChannelPermRepo,
	roleRepo *testutil.MockRoleRepo,
	channelRepo *testutil.MockChannelRepo,
	hub *testutil.MockBroadcaster,
) ChannelPermissionService {
	return NewChannelPermissionService(permRepo, roleRepo, channelRepo, hub)
}

// ─── ResolveChannelPermissions ───

func TestResolveChannelPermissions(t *testing.T) {
	const (
		userID    = "user-1"
		channelID = "chan-1"
		serverID  = "srv-1"
	)

	baseChannel := &models.Channel{ID: channelID, ServerID: serverID}

	tests := []struct {
		name      string
		roles     []models.Role
		overrides []models.ChannelPermissionOverride
		want      models.Permission
		wantErr   bool
	}{
		{
			name:  "should return 0 when user has no roles",
			roles: []models.Role{},
			want:  0,
		},
		{
			name: "should return base permissions when no overrides exist",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages},
			},
			overrides: nil,
			want:      models.PermSendMessages | models.PermReadMessages,
		},
		{
			name: "should return PermAll when user has Admin role",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermAdmin | models.PermSendMessages},
			},
			want: models.PermAll,
		},
		{
			name: "should remove denied permission from base",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Allow: 0, Deny: models.PermSendMessages},
			},
			want: models.PermReadMessages, // SendMessages stripped by deny
		},
		{
			name: "should add allowed permission not in base",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermReadMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Allow: models.PermSendMessages, Deny: 0},
			},
			want: models.PermReadMessages | models.PermSendMessages,
		},
		{
			name: "should let allow override deny for the same bit",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Allow: models.PermSendMessages, Deny: models.PermSendMessages},
			},
			// (base & ^deny) | allow => removes SendMessages then adds it back
			want: models.PermSendMessages | models.PermReadMessages,
		},
		{
			name: "should OR base permissions from multiple roles",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages},
				{ID: "r2", Permissions: models.PermReadMessages},
			},
			overrides: nil,
			want:      models.PermSendMessages | models.PermReadMessages,
		},
		{
			name: "should OR overrides across multiple roles",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages | models.PermConnectVoice},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Allow: 0, Deny: models.PermSendMessages},
				{ChannelID: channelID, RoleID: "r2", Allow: models.PermSpeak, Deny: models.PermConnectVoice},
			},
			// channelDeny = SendMessages | ConnectVoice
			// channelAllow = Speak
			// effective = ((Send|Read|Connect) & ^(Send|Connect)) | Speak = Read | Speak
			want: models.PermReadMessages | models.PermSpeak,
		},
		{
			name: "should bypass overrides completely for admin even with deny overrides",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermAdmin},
			},
			// overrides should not even be fetched for admin
			overrides: nil,
			want:      models.PermAll,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			permRepo := &testutil.MockChannelPermRepo{
				GetByChannelAndRolesFn: func(_ context.Context, _ string, _ []string) ([]models.ChannelPermissionOverride, error) {
					return tt.overrides, nil
				},
			}
			roleRepo := &testutil.MockRoleRepo{
				GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
					return tt.roles, nil
				},
			}
			channelRepo := &testutil.MockChannelRepo{
				GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
					return baseChannel, nil
				},
			}
			hub := &testutil.MockBroadcaster{}

			svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
			got, err := svc.ResolveChannelPermissions(context.Background(), userID, channelID)

			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("got permission %d, want %d", got, tt.want)
			}
		})
	}
}

func TestResolveChannelPermissions_ChannelNotFound(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return nil, errors.New("channel not found")
		},
	}
	roleRepo := &testutil.MockRoleRepo{}
	permRepo := &testutil.MockChannelPermRepo{}
	hub := &testutil.MockBroadcaster{}

	svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
	_, err := svc.ResolveChannelPermissions(context.Background(), "u1", "bad-chan")
	if err == nil {
		t.Fatal("expected error when channel not found")
	}
}

func TestResolveChannelPermissions_RoleRepoError(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "c1", ServerID: "s1"}, nil
		},
	}
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return nil, errors.New("db error")
		},
	}
	permRepo := &testutil.MockChannelPermRepo{}
	hub := &testutil.MockBroadcaster{}

	svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
	_, err := svc.ResolveChannelPermissions(context.Background(), "u1", "c1")
	if err == nil {
		t.Fatal("expected error when role repo fails")
	}
}

// ─── BuildVisibilityFilter ───

func TestBuildVisibilityFilter(t *testing.T) {
	const (
		userID   = "user-1"
		serverID = "srv-1"
	)

	tests := []struct {
		name            string
		roles           []models.Role
		overrides       []models.ChannelPermissionOverride
		wantAdmin       bool
		wantHasBaseView bool
		wantHidden      map[string]bool
		wantGranted     map[string]bool
	}{
		{
			name: "should return IsAdmin when user has Admin permission",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermAdmin},
			},
			wantAdmin: true,
		},
		{
			name: "should return empty maps when no overrides exist and user has ViewChannel",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermViewChannel | models.PermSendMessages},
			},
			overrides:       nil,
			wantHasBaseView: true,
			wantHidden:      map[string]bool{},
			wantGranted:     map[string]bool{},
		},
		{
			name: "should hide channel when base has ViewChannel but deny override removes it",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermViewChannel | models.PermSendMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: "chan-secret", RoleID: "r1", Allow: 0, Deny: models.PermViewChannel},
			},
			wantHasBaseView: true,
			wantHidden:      map[string]bool{"chan-secret": true},
			wantGranted:     map[string]bool{},
		},
		{
			name: "should grant channel when base lacks ViewChannel but allow override adds it",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages}, // no ViewChannel
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: "chan-special", RoleID: "r1", Allow: models.PermViewChannel, Deny: 0},
			},
			wantHasBaseView: false,
			wantHidden:      map[string]bool{},
			wantGranted:     map[string]bool{"chan-special": true},
		},
		{
			name: "should handle multiple channels with mixed overrides",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermViewChannel | models.PermSendMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: "chan-hidden", RoleID: "r1", Allow: 0, Deny: models.PermViewChannel},
				{ChannelID: "chan-visible", RoleID: "r1", Allow: models.PermSpeak, Deny: 0}, // no ViewChannel change
			},
			wantHasBaseView: true,
			wantHidden:      map[string]bool{"chan-hidden": true},
			wantGranted:     map[string]bool{}, // chan-visible still visible via base
		},
		{
			name:            "should return empty filter when user has no roles",
			roles:           []models.Role{},
			overrides:       nil,
			wantHasBaseView: false,
			wantHidden:      map[string]bool{},
			wantGranted:     map[string]bool{},
		},
		{
			name: "should OR overrides across multiple roles for same channel",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages}, // no ViewChannel
				{ID: "r2", Permissions: 0},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: "chan-1", RoleID: "r1", Allow: 0, Deny: 0},
				{ChannelID: "chan-1", RoleID: "r2", Allow: models.PermViewChannel, Deny: 0},
			},
			wantHasBaseView: false,
			wantHidden:      map[string]bool{},
			wantGranted:     map[string]bool{"chan-1": true},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			roleRepo := &testutil.MockRoleRepo{
				GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
					return tt.roles, nil
				},
			}
			permRepo := &testutil.MockChannelPermRepo{
				GetByRolesFn: func(_ context.Context, _ []string) ([]models.ChannelPermissionOverride, error) {
					return tt.overrides, nil
				},
			}
			channelRepo := &testutil.MockChannelRepo{}
			hub := &testutil.MockBroadcaster{}

			svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
			filter, err := svc.BuildVisibilityFilter(context.Background(), userID, serverID)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if filter.IsAdmin != tt.wantAdmin {
				t.Errorf("IsAdmin = %v, want %v", filter.IsAdmin, tt.wantAdmin)
			}

			// Admin filter has no further fields to check
			if tt.wantAdmin {
				return
			}

			if filter.HasBaseView != tt.wantHasBaseView {
				t.Errorf("HasBaseView = %v, want %v", filter.HasBaseView, tt.wantHasBaseView)
			}

			if len(filter.HiddenChannels) != len(tt.wantHidden) {
				t.Errorf("HiddenChannels length = %d, want %d", len(filter.HiddenChannels), len(tt.wantHidden))
			}
			for ch := range tt.wantHidden {
				if !filter.HiddenChannels[ch] {
					t.Errorf("expected channel %s to be hidden", ch)
				}
			}

			if len(filter.GrantedChannels) != len(tt.wantGranted) {
				t.Errorf("GrantedChannels length = %d, want %d", len(filter.GrantedChannels), len(tt.wantGranted))
			}
			for ch := range tt.wantGranted {
				if !filter.GrantedChannels[ch] {
					t.Errorf("expected channel %s to be granted", ch)
				}
			}
		})
	}
}

func TestBuildVisibilityFilter_RoleRepoError(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return nil, errors.New("db error")
		},
	}
	permRepo := &testutil.MockChannelPermRepo{}
	channelRepo := &testutil.MockChannelRepo{}
	hub := &testutil.MockBroadcaster{}

	svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
	_, err := svc.BuildVisibilityFilter(context.Background(), "u1", "s1")
	if err == nil {
		t.Fatal("expected error when role repo fails")
	}
}

func TestBuildVisibilityFilter_PermRepoError(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return []models.Role{{ID: "r1", Permissions: models.PermViewChannel}}, nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{
		GetByRolesFn: func(_ context.Context, _ []string) ([]models.ChannelPermissionOverride, error) {
			return nil, errors.New("db error")
		},
	}
	channelRepo := &testutil.MockChannelRepo{}
	hub := &testutil.MockBroadcaster{}

	svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
	_, err := svc.BuildVisibilityFilter(context.Background(), "u1", "s1")
	if err == nil {
		t.Fatal("expected error when perm repo fails")
	}
}
