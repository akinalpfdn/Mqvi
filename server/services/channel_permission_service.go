// Package services — ChannelPermissionService: per-channel permission overrides.
//
// Discord-style per-channel role overrides with allow/deny bits.
//
// Permission resolution (Discord algorithm):
//
//	base = OR of all role permissions
//	channelAllow = OR of override allows for user's roles
//	channelDeny  = OR of override denies for user's roles
//	effective    = (base & ~channelDeny) | channelAllow
//
// Admin bypasses all overrides.
package services

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/cache"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

const (
	permCacheTTL     = 30 * time.Second
	permCacheCleanup = 5 * time.Minute
)

// ChannelPermResolver is an ISP interface for permission resolution only.
// Used by MessageService and VoiceService to avoid depending on the full ChannelPermissionService.
type ChannelPermResolver interface {
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
	// ResolveChannelPermissionsFresh bypasses the cache (and refreshes it) so a caller acting
	// on a just-changed permission — e.g. live voice enforcement after a role/member change,
	// which does NOT invalidate this cache — sees current state, not a ≤30s-stale entry.
	ResolveChannelPermissionsFresh(ctx context.Context, userID, channelID string) (models.Permission, error)
}

// VoiceChannelPermissionEnforcer re-applies effective voice permissions at the SFU for
// users already in a voice channel after its overrides change, and resends the server's members
// the voice state they may now see. Implemented by voiceService.
type VoiceChannelPermissionEnforcer interface {
	EnforceChannelVoicePermissions(channelID string)
	ResyncChannelVisibility(serverID, channelID string)
}

// PermissionCacheInvalidator drops cached permission entries when a role or membership
// change makes them stale. The perm cache is otherwise only invalidated on per-channel
// override changes, so without this a role permission edit or a member's role change would
// not take effect (join/send/permission gates would see a ≤30s-stale entry). Implemented
// by channelPermService; consumed by role/member services (wired post-construction).
type PermissionCacheInvalidator interface {
	// InvalidateUserPermissions drops every cached entry for one user (all channels).
	InvalidateUserPermissions(userID string)
	// InvalidateAllPermissions clears the whole cache — used when a role's permission bits
	// change or a role is deleted, which can affect every holder across every channel.
	InvalidateAllPermissions()
}

// ChannelPermissionService manages per-channel permission overrides.
type ChannelPermissionService interface {
	GetOverrides(ctx context.Context, serverID, channelID string) ([]models.ChannelPermissionOverride, error)
	// SetOverride creates or updates an override. If allow=0 and deny=0, deletes it (revert to inherit).
	SetOverride(ctx context.Context, serverID, channelID, roleID string, req *models.SetOverrideRequest) error
	DeleteOverride(ctx context.Context, serverID, channelID, roleID string) error
	// ResolveChannelPermissions computes effective permissions for a user in a channel.
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
	// ResolveChannelPermissionsFresh is ResolveChannelPermissions with a forced cache refresh.
	ResolveChannelPermissionsFresh(ctx context.Context, userID, channelID string) (models.Permission, error)
	// BuildVisibilityFilter builds a per-user channel visibility filter for ViewChannel checks.
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)
	// FilterUsersWithPermission keeps the users holding required in a channel (batched, uncached).
	FilterUsersWithPermission(ctx context.Context, channelID string, userIDs []string, required models.Permission) ([]string, error)
	// SetVoiceEnforcer wires the voice enforcer (post-construction — voiceService is built
	// after this service, which it depends on).
	SetVoiceEnforcer(enforcer VoiceChannelPermissionEnforcer)
	PermissionCacheInvalidator
}

type channelPermService struct {
	permRepo      repository.ChannelPermissionRepository
	roleRepo      repository.RoleRepository
	channelGetter ChannelGetter
	hub           ws.Broadcaster
	voiceEnforcer VoiceChannelPermissionEnforcer // set post-construction, may be nil

	// Cache for ResolveChannelPermissions results. Key: "userID:channelID".
	// Invalidated per-channel when overrides change.
	permCache *cache.TTLCache[string, models.Permission]
}

func (s *channelPermService) SetVoiceEnforcer(enforcer VoiceChannelPermissionEnforcer) {
	s.voiceEnforcer = enforcer
}

// enforceChannelVoice re-checks the channel's voice participants after an override change and
// resyncs who sees them. The SFU part is fire-and-forget so the admin's request isn't blocked on
// LiveKit I/O; the resync only queues.
func (s *channelPermService) enforceChannelVoice(serverID, channelID string) {
	if s.voiceEnforcer != nil {
		go s.voiceEnforcer.EnforceChannelVoicePermissions(channelID)
		s.voiceEnforcer.ResyncChannelVisibility(serverID, channelID)
	}
}

func NewChannelPermissionService(
	permRepo repository.ChannelPermissionRepository,
	roleRepo repository.RoleRepository,
	channelGetter ChannelGetter,
	hub ws.Broadcaster,
) ChannelPermissionService {
	return &channelPermService{
		permRepo:      permRepo,
		roleRepo:      roleRepo,
		channelGetter: channelGetter,
		hub:           hub,
		permCache:     cache.New[string, models.Permission](permCacheTTL, permCacheCleanup),
	}
}

func (s *channelPermService) GetOverrides(ctx context.Context, serverID, channelID string) ([]models.ChannelPermissionOverride, error) {
	// IDOR guard: the channel must belong to the route's server.
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel == nil || channel.ServerID != serverID {
		return nil, fmt.Errorf("%w: channel does not belong to this server", pkg.ErrForbidden)
	}

	overrides, err := s.permRepo.GetByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel overrides: %w", err)
	}

	if overrides == nil {
		overrides = []models.ChannelPermissionOverride{}
	}

	return overrides, nil
}

func (s *channelPermService) SetOverride(ctx context.Context, serverID, channelID, roleID string, req *models.SetOverrideRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("invalid override request: %w", err)
	}

	// IDOR guard: the channel must belong to the route's server.
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return err
	}
	if channel == nil || channel.ServerID != serverID {
		return fmt.Errorf("%w: channel does not belong to this server", pkg.ErrForbidden)
	}

	// allow=0, deny=0 -> no effect (same as inherit), delete
	if req.Allow == 0 && req.Deny == 0 {
		if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
			log.Printf("[channel-perm] failed to delete override (idempotent, non-fatal) channel=%s role=%s: %v", channelID, roleID, err)
		}

		s.invalidateChannelCache(channelID)
		s.enforceChannelVoice(serverID, channelID)

		s.hub.BroadcastToServer(serverID, ws.Event{
			Op: ws.OpChannelPermissionDelete,
			Data: map[string]string{
				"channel_id": channelID,
				"role_id":    roleID,
			},
		})

		return nil
	}

	override := &models.ChannelPermissionOverride{
		ChannelID: channelID,
		RoleID:    roleID,
		Allow:     req.Allow,
		Deny:      req.Deny,
	}

	if err := s.permRepo.Set(ctx, override); err != nil {
		return fmt.Errorf("failed to set channel override: %w", err)
	}

	s.invalidateChannelCache(channelID)
	s.enforceChannelVoice(serverID, channelID)

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelPermissionUpdate,
		Data: override,
	})

	return nil
}

func (s *channelPermService) DeleteOverride(ctx context.Context, serverID, channelID, roleID string) error {
	// IDOR guard: the channel must belong to the route's server.
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return err
	}
	if channel == nil || channel.ServerID != serverID {
		return fmt.Errorf("%w: channel does not belong to this server", pkg.ErrForbidden)
	}

	if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
		return fmt.Errorf("failed to delete channel override: %w", err)
	}

	s.invalidateChannelCache(channelID)
	s.enforceChannelVoice(serverID, channelID)

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpChannelPermissionDelete,
		Data: map[string]string{
			"channel_id": channelID,
			"role_id":    roleID,
		},
	})

	return nil
}

// BuildVisibilityFilter builds a per-user channel visibility filter.
// Returns IsAdmin=true if user has Admin permission (sees all channels).
func (s *channelPermService) BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error) {
	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user roles for visibility filter: %w", err)
	}

	var base models.Permission
	roleIDs := make([]string, len(roles))
	for i, r := range roles {
		base |= r.Permissions
		roleIDs[i] = r.ID
	}

	if base.Has(models.PermAdmin) {
		return &ChannelVisibilityFilter{IsAdmin: true}, nil
	}

	hasBaseView := base.Has(models.PermViewChannel)

	overrides, err := s.permRepo.GetByRoles(ctx, roleIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to get role overrides for visibility filter: %w", err)
	}

	if len(overrides) == 0 {
		return &ChannelVisibilityFilter{
			HasBaseView:     hasBaseView,
			HiddenChannels:  make(map[string]bool),
			GrantedChannels: make(map[string]bool),
		}, nil
	}

	// Group overrides by channel, OR allow/deny across all user roles
	type channelOverride struct {
		allow models.Permission
		deny  models.Permission
	}
	byChannel := make(map[string]*channelOverride)
	for _, o := range overrides {
		co, ok := byChannel[o.ChannelID]
		if !ok {
			co = &channelOverride{}
			byChannel[o.ChannelID] = co
		}
		co.allow |= o.Allow
		co.deny |= o.Deny
	}

	hidden := make(map[string]bool)
	granted := make(map[string]bool)

	for channelID, co := range byChannel {
		effective := (base & ^co.deny) | co.allow
		hasView := effective.Has(models.PermViewChannel)

		if hasBaseView && !hasView {
			hidden[channelID] = true
		} else if !hasBaseView && hasView {
			granted[channelID] = true
		}
	}

	return &ChannelVisibilityFilter{
		HasBaseView:     hasBaseView,
		HiddenChannels:  hidden,
		GrantedChannels: granted,
	}, nil
}

// ResolveChannelPermissionsFresh drops the cached entry for this user+channel, then
// resolves (repopulating the cache). Used by live voice enforcement so it acts on current
// permissions even when the trigger (role / member-role change) didn't invalidate the cache
// — and so a user disconnected for a lost permission can't rejoin via a stale cache hit.
func (s *channelPermService) ResolveChannelPermissionsFresh(ctx context.Context, userID, channelID string) (models.Permission, error) {
	s.permCache.Delete(userID + ":" + channelID)
	return s.ResolveChannelPermissions(ctx, userID, channelID)
}

func (s *channelPermService) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	cacheKey := userID + ":" + channelID
	if cached, ok := s.permCache.Get(cacheKey); ok {
		return cached, nil
	}

	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("failed to get channel for permission resolution: %w", err)
	}

	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, channel.ServerID)
	if err != nil {
		return 0, fmt.Errorf("failed to get user roles: %w", err)
	}

	var overrides []models.ChannelPermissionOverride
	if !foldBasePermissions(roles).Has(models.PermAdmin) {
		roleIDs := make([]string, len(roles))
		for i, role := range roles {
			roleIDs[i] = role.ID
		}
		overrides, err = s.permRepo.GetByChannelAndRoles(ctx, channelID, roleIDs)
		if err != nil {
			return 0, fmt.Errorf("failed to get channel overrides for roles: %w", err)
		}
	}

	effective := foldChannelPermissions(roles, overrides)
	s.permCache.Set(cacheKey, effective)
	return effective, nil
}

// FilterUsersWithPermission returns the users whose effective permissions in channelID include
// required, in input order. Three queries for any number of users, and never the cache: it decides
// who receives an event, so a stale grant would be a leak rather than a 30-second delay.
func (s *channelPermService) FilterUsersWithPermission(ctx context.Context, channelID string, userIDs []string, required models.Permission) ([]string, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("get channel %s: %w", channelID, err)
	}
	if channel == nil {
		return nil, fmt.Errorf("get channel %s: %w", channelID, pkg.ErrNotFound)
	}
	rolesByUser, err := s.roleRepo.GetByUsersAndServer(ctx, channel.ServerID, userIDs)
	if err != nil {
		return nil, fmt.Errorf("get roles for channel %s audience: %w", channelID, err)
	}
	overrides, err := s.permRepo.GetByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("get overrides for channel %s: %w", channelID, err)
	}

	out := make([]string, 0, len(userIDs))
	for _, uid := range userIDs {
		roles := rolesByUser[uid]
		if hasAllPermissions(foldChannelPermissions(roles, overridesForRoles(overrides, roles)), required) {
			out = append(out, uid)
		}
	}
	return out, nil
}

// foldBasePermissions is the OR of a user's role permissions.
func foldBasePermissions(roles []models.Role) models.Permission {
	var base models.Permission
	for _, r := range roles {
		base |= r.Permissions
	}
	return base
}

// foldChannelPermissions is the one implementation of the effective-permission formula
// (base &^ deny) | allow, over overrides already narrowed to the user's roles.
func foldChannelPermissions(roles []models.Role, overrides []models.ChannelPermissionOverride) models.Permission {
	base := foldBasePermissions(roles)
	if base.Has(models.PermAdmin) {
		return models.PermAll
	}
	var allow, deny models.Permission
	for _, o := range overrides {
		allow |= o.Allow
		deny |= o.Deny
	}
	return (base &^ deny) | allow
}

// overridesForRoles narrows a channel's full override list to the roles a user holds — what
// GetByChannelAndRoles returns for that user.
func overridesForRoles(overrides []models.ChannelPermissionOverride, roles []models.Role) []models.ChannelPermissionOverride {
	if len(overrides) == 0 || len(roles) == 0 {
		return nil
	}
	held := make(map[string]bool, len(roles))
	for _, r := range roles {
		held[r.ID] = true
	}
	var out []models.ChannelPermissionOverride
	for _, o := range overrides {
		if held[o.RoleID] {
			out = append(out, o)
		}
	}
	return out
}

// hasAllPermissions is Permission.Has for a multi-bit requirement: every bit, or Admin.
func hasAllPermissions(perms, required models.Permission) bool {
	return perms&required == required || perms.Has(models.PermAdmin)
}

// invalidateChannelCache clears all cached permissions for a given channel.
// Uses suffix match on "userID:channelID" keys since we can't know which users are affected.
func (s *channelPermService) invalidateChannelCache(channelID string) {
	suffix := ":" + channelID
	s.permCache.DeleteFunc(func(key string) bool {
		return strings.HasSuffix(key, suffix)
	})
}

// InvalidateUserPermissions drops every cached entry for one user across all channels.
// The "userID:" prefix (with the ':' delimiter) can't collide with another user whose ID
// is a prefix of this one. Called when a member's role assignment changes (ModifyRoles).
func (s *channelPermService) InvalidateUserPermissions(userID string) {
	prefix := userID + ":"
	s.permCache.DeleteFunc(func(key string) bool {
		return strings.HasPrefix(key, prefix)
	})
}

// InvalidateAllPermissions clears the entire permission cache. Used when a role's
// permission bits change or a role is deleted — that can affect every holder across every
// channel, and the cache key (userID:channelID) carries no role/server dimension to scope
// by. Role edits/deletes are infrequent admin actions, so a full flush (lazy re-resolve on
// next access) is an acceptable cost for correctness.
func (s *channelPermService) InvalidateAllPermissions() {
	s.permCache.Clear()
}
