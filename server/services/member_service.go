package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// MemberService handles member management. All operations are server-scoped.
type MemberService interface {
	GetAll(ctx context.Context, serverID string) ([]models.MemberWithRoles, error)
	GetByID(ctx context.Context, serverID, userID string) (*models.MemberWithRoles, error)
	UpdateProfile(ctx context.Context, userID string, req *models.UpdateProfileRequest) (*models.MemberWithRoles, error)
	UpdatePresence(ctx context.Context, userID string, status models.UserStatus) error
	ModifyRoles(ctx context.Context, serverID, actorID, targetID string, roleIDs []string) (*models.MemberWithRoles, error)
	Kick(ctx context.Context, serverID, actorID, targetID string) error
	Ban(ctx context.Context, serverID, actorID, targetID, reason string) error
	Unban(ctx context.Context, serverID, userID string) error
	GetBans(ctx context.Context, serverID string) ([]models.Ban, error)
	IsBanned(ctx context.Context, serverID, userID string) (bool, error)
	// SetVoiceEnforcer wires the voice enforcer post-construction.
	SetVoiceEnforcer(enforcer VoiceUserPermissionEnforcer)
	// SetPermCacheInvalidator wires the permission-cache invalidator post-construction.
	SetPermCacheInvalidator(inv PermissionCacheInvalidator)
}

// VoiceDisconnecter disconnects a user from voice on kick/ban (ISP).
type VoiceDisconnecter interface {
	DisconnectUser(userID string)
}

// VoiceProfileSyncer refreshes a user's cached voice-state profile after a
// profile change, so a voice reconnect doesn't serve a stale (deleted) avatar (ISP).
type VoiceProfileSyncer interface {
	UpdateUserProfile(userID, username, displayName, avatarURL string)
}

// VoiceUserPermissionEnforcer re-applies a single user's voice permissions at the SFU after
// their role assignments change (S3).
type VoiceUserPermissionEnforcer interface {
	EnforceUserVoicePermissions(userID string)
}

type memberService struct {
	userRepo      repository.UserRepository
	roleRepo      repository.RoleRepository
	banRepo       repository.BanRepository
	serverRepo    repository.ServerRepository
	hub           ws.BroadcastAndManage
	voiceKick     VoiceDisconnecter
	voiceProfile  VoiceProfileSyncer
	voiceEnforcer   VoiceUserPermissionEnforcer // set post-construction, may be nil
	permInvalidator PermissionCacheInvalidator  // set post-construction, may be nil
	urlSigner       FileURLSigner
}

func (s *memberService) SetVoiceEnforcer(enforcer VoiceUserPermissionEnforcer) {
	s.voiceEnforcer = enforcer
}

func (s *memberService) SetPermCacheInvalidator(inv PermissionCacheInvalidator) {
	s.permInvalidator = inv
}

func NewMemberService(
	userRepo repository.UserRepository,
	roleRepo repository.RoleRepository,
	banRepo repository.BanRepository,
	serverRepo repository.ServerRepository,
	hub ws.BroadcastAndManage,
	voiceKick VoiceDisconnecter,
	voiceProfile VoiceProfileSyncer,
	urlSigner FileURLSigner,
) MemberService {
	return &memberService{
		userRepo:     userRepo,
		roleRepo:     roleRepo,
		banRepo:      banRepo,
		serverRepo:   serverRepo,
		hub:          hub,
		voiceKick:    voiceKick,
		voiceProfile: voiceProfile,
		urlSigner:    urlSigner,
	}
}

func (s *memberService) GetAll(ctx context.Context, serverID string) ([]models.MemberWithRoles, error) {
	users, err := s.userRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get all users: %w", err)
	}

	members := make([]models.MemberWithRoles, 0)
	for i := range users {
		// Skip soft-deleted/tombstone users — they shouldn't appear in active member lists.
		// Their messages stay (tombstone preserves messages.user_id), but they themselves
		// are no longer "members" of the server in the UI sense.
		if users[i].DeletedAt != nil {
			continue
		}

		isMember, err := s.serverRepo.IsMember(ctx, serverID, users[i].ID)
		if err != nil {
			return nil, fmt.Errorf("failed to check membership: %w", err)
		}
		if !isMember {
			continue
		}

		roles, err := s.roleRepo.GetByUserIDAndServer(ctx, users[i].ID, serverID)
		if err != nil {
			return nil, fmt.Errorf("failed to get roles for user %s: %w", users[i].ID, err)
		}
		m := models.ToMemberWithRoles(&users[i], roles)
		m.AvatarURL = s.urlSigner.SignURLPtr(m.AvatarURL)
		members = append(members, m)
	}

	return members, nil
}

func (s *memberService) GetByID(ctx context.Context, serverID, userID string) (*models.MemberWithRoles, error) {
	// Active member only — deleted users return 404 (they're not part of the server's active roster).
	user, err := s.userRepo.GetActiveByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles for user: %w", err)
	}

	member := models.ToMemberWithRoles(user, roles)
	member.AvatarURL = s.urlSigner.SignURLPtr(member.AvatarURL)
	return &member, nil
}

func (s *memberService) UpdateProfile(ctx context.Context, userID string, req *models.UpdateProfileRequest) (*models.MemberWithRoles, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	if req.Username != nil && !strings.EqualFold(*req.Username, user.Username) {
		existing, existErr := s.userRepo.GetByUsername(ctx, *req.Username)
		if existErr == nil && existing.ID != userID {
			return nil, fmt.Errorf("%w: username is already taken", pkg.ErrAlreadyExists)
		}
		if existErr != nil && !errors.Is(existErr, pkg.ErrNotFound) {
			return nil, fmt.Errorf("failed to check username availability: %w", existErr)
		}
		banned, banErr := s.userRepo.IsUsernamePlatformBanned(ctx, *req.Username)
		if banErr != nil {
			return nil, fmt.Errorf("failed to check username ban: %w", banErr)
		}
		if banned {
			return nil, fmt.Errorf("%w: this username is not allowed", pkg.ErrForbidden)
		}
		user.Username = *req.Username
	}
	if req.DisplayName != nil {
		if *req.DisplayName == "" {
			user.DisplayName = nil
		} else {
			user.DisplayName = req.DisplayName
		}
	}
	if req.AvatarURL != nil {
		// Lock avatar_url to a path the user actually owns. Without this gate
		// any caller of PATCH /users/me/profile could point their avatar at an
		// arbitrary /api/files/... URL — including private DM attachments —
		// and the server would happily sign and serve it on every egress.
		// Empty string clears the avatar; non-empty must be the canonical
		// /api/files/avatars/<userID>/... path the upload handler produces.
		clean, err := normalizeOwnAvatarURL(*req.AvatarURL, userID)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
		}
		if clean == "" {
			user.AvatarURL = nil
		} else {
			user.AvatarURL = &clean
		}
	}
	if req.CustomStatus != nil {
		if *req.CustomStatus == "" {
			user.CustomStatus = nil
		} else {
			user.CustomStatus = req.CustomStatus
		}
	}
	if req.Language != nil {
		user.Language = *req.Language
	}
	if req.DMPrivacy != nil {
		user.DMPrivacy = *req.DMPrivacy
	}

	if err := s.userRepo.Update(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to update user profile: %w", err)
	}

	// Keep the in-memory voice state fresh so a voice reconnect doesn't reload
	// the old (now-deleted) avatar. Live clients get the change via OpMemberUpdate below.
	if s.voiceProfile != nil {
		display := ""
		if user.DisplayName != nil {
			display = *user.DisplayName
		}
		avatar := ""
		if user.AvatarURL != nil {
			avatar = *user.AvatarURL
		}
		s.voiceProfile.UpdateUserProfile(userID, user.Username, display, avatar)
	}

	// Broadcast to all servers the user belongs to (not BroadcastToAll)
	member := models.ToMemberWithRoles(user, nil)
	member.AvatarURL = s.urlSigner.SignURLPtr(member.AvatarURL)
	servers, srvErr := s.serverRepo.GetUserServers(ctx, userID)
	if srvErr == nil {
		for _, srv := range servers {
			s.hub.BroadcastToServer(srv.ID, ws.Event{
				Op:   ws.OpMemberUpdate,
				Data: &member,
			})
		}
	}

	return &member, nil
}

func (s *memberService) UpdatePresence(ctx context.Context, userID string, status models.UserStatus) error {
	if err := s.userRepo.UpdateStatus(ctx, userID, status); err != nil {
		return fmt.Errorf("failed to update presence: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpPresence,
		Data: map[string]string{
			"user_id": userID,
			"status":  string(status),
		},
	})

	return nil
}

func (s *memberService) ModifyRoles(ctx context.Context, serverID, actorID, targetID string, roleIDs []string) (*models.MemberWithRoles, error) {
	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get actor roles: %w", err)
	}
	actorMaxPos := models.HighestPosition(actorRoles)

	targetRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, targetID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get target roles: %w", err)
	}
	targetMaxPos := models.HighestPosition(targetRoles)

	if models.HasOwnerRole(targetRoles) {
		return nil, fmt.Errorf("%w: cannot modify the server owner's roles", pkg.ErrForbidden)
	}

	if targetMaxPos >= actorMaxPos {
		return nil, fmt.Errorf("%w: cannot modify roles of a user with equal or higher role", pkg.ErrForbidden)
	}

	for _, roleID := range roleIDs {
		role, err := s.roleRepo.GetByID(ctx, roleID)
		if err != nil {
			return nil, fmt.Errorf("role %s not found: %w", roleID, err)
		}
		// IDOR guard: role IDs are globally unique, so a role from another server must
		// never be assignable here — otherwise its permission bits (e.g. Admin on a
		// position-0 role) leak into the target's effective perms (privilege escalation).
		if role.ServerID != serverID {
			return nil, fmt.Errorf("%w: role does not belong to this server", pkg.ErrForbidden)
		}
		if role.Position >= actorMaxPos {
			return nil, fmt.Errorf("%w: cannot assign role '%s' with equal or higher position", pkg.ErrForbidden, role.Name)
		}
	}

	currentSet := make(map[string]bool, len(targetRoles))
	for _, r := range targetRoles {
		currentSet[r.ID] = true
	}

	targetSet := make(map[string]bool, len(roleIDs))
	for _, id := range roleIDs {
		targetSet[id] = true
	}

	for _, id := range roleIDs {
		if !currentSet[id] {
			if err := s.roleRepo.AssignToUser(ctx, targetID, id, serverID); err != nil {
				return nil, fmt.Errorf("failed to assign role: %w", err)
			}
		}
	}

	for _, r := range targetRoles {
		if !targetSet[r.ID] {
			if r.IsDefault {
				continue
			}
			if r.Position >= actorMaxPos {
				continue
			}
			if err := s.roleRepo.RemoveFromUser(ctx, targetID, r.ID); err != nil {
				return nil, fmt.Errorf("failed to remove role: %w", err)
			}
		}
	}

	member, err := s.GetByID(ctx, serverID, targetID)
	if err != nil {
		return nil, err
	}

	// The user's role set changed: drop their stale cached perms so join/send gates see the
	// new set immediately, and enforce it live if they're already in voice (S3).
	if s.permInvalidator != nil {
		s.permInvalidator.InvalidateUserPermissions(targetID)
	}
	if s.voiceEnforcer != nil {
		go s.voiceEnforcer.EnforceUserVoicePermissions(targetID)
	}

	// Role changes are server-scoped — only broadcast to that server
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpMemberUpdate,
		Data: member,
	})

	return member, nil
}

func (s *memberService) Kick(ctx context.Context, serverID, actorID, targetID string) error {
	if actorID == targetID {
		return fmt.Errorf("%w: cannot kick yourself", pkg.ErrBadRequest)
	}

	if err := s.checkHierarchy(ctx, serverID, actorID, targetID); err != nil {
		return err
	}

	if err := s.serverRepo.RemoveMember(ctx, serverID, targetID); err != nil {
		return fmt.Errorf("failed to kick user: %w", err)
	}

	s.removeFromServer(serverID, targetID)
	return nil
}

func (s *memberService) Ban(ctx context.Context, serverID, actorID, targetID, reason string) error {
	if actorID == targetID {
		return fmt.Errorf("%w: cannot ban yourself", pkg.ErrBadRequest)
	}

	if err := s.checkHierarchy(ctx, serverID, actorID, targetID); err != nil {
		return err
	}

	target, err := s.userRepo.GetByID(ctx, targetID)
	if err != nil {
		return fmt.Errorf("failed to get target user: %w", err)
	}

	ban := &models.Ban{
		ServerID: serverID,
		UserID:   targetID,
		Username: target.Username,
		Reason:   reason,
		BannedBy: actorID,
	}

	if err := s.banRepo.Create(ctx, ban); err != nil {
		return fmt.Errorf("failed to create ban: %w", err)
	}

	// Remove membership (best-effort — ban already created)
	if rmErr := s.serverRepo.RemoveMember(ctx, serverID, targetID); rmErr != nil {
		log.Printf("[member] failed to remove member after ban server=%s user=%s: %v", serverID, targetID, rmErr)
	}

	s.removeFromServer(serverID, targetID)
	return nil
}

// removeFromServer handles post-kick/ban cleanup: voice disconnect, WS broadcasts, subscription removal.
// Order matters: broadcast before removing subscription so the kicked user receives the events.
func (s *memberService) removeFromServer(serverID, targetID string) {
	// Drop the removed user's cached permissions so a stale entry can't let them pass a
	// permission check in the ≤30s cache window after they're no longer a member (adjacent
	// to #6 — a kick/ban is a membership change too).
	if s.permInvalidator != nil {
		s.permInvalidator.InvalidateUserPermissions(targetID)
	}

	if s.voiceKick != nil {
		s.voiceKick.DisconnectUser(targetID)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpMemberLeave,
		Data: map[string]string{
			"server_id": serverID,
			"user_id":   targetID,
		},
	})

	s.hub.BroadcastToUser(targetID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	s.hub.RemoveClientServerID(targetID, serverID)
}

func (s *memberService) Unban(ctx context.Context, serverID, userID string) error {
	return s.banRepo.Delete(ctx, serverID, userID)
}

func (s *memberService) GetBans(ctx context.Context, serverID string) ([]models.Ban, error) {
	return s.banRepo.GetAllByServer(ctx, serverID)
}

func (s *memberService) IsBanned(ctx context.Context, serverID, userID string) (bool, error) {
	return s.banRepo.Exists(ctx, serverID, userID)
}

func (s *memberService) checkHierarchy(ctx context.Context, serverID, actorID, targetID string) error {
	targetRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, targetID, serverID)
	if err != nil {
		return fmt.Errorf("failed to get target roles: %w", err)
	}

	if models.HasOwnerRole(targetRoles) {
		return fmt.Errorf("%w: the server owner cannot be kicked or banned", pkg.ErrForbidden)
	}

	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return fmt.Errorf("failed to get actor roles: %w", err)
	}

	actorMaxPos := models.HighestPosition(actorRoles)
	targetMaxPos := models.HighestPosition(targetRoles)

	if actorMaxPos <= targetMaxPos {
		return fmt.Errorf("%w: insufficient role hierarchy", pkg.ErrForbidden)
	}

	return nil
}

// normalizeOwnAvatarURL accepts the avatar_url field from a profile update and
// either rejects it or returns a clean path safe to store. Rules:
//   - empty string → returns "" (caller clears AvatarURL)
//   - canonical own-avatar path produced by the upload handler
//     ("/api/files/avatars/<userID>/<filename>", optionally with ?exp=&sig=) →
//     returns the path with all query params stripped
//   - anything else → error
//
// The filename segment is percent-decoded before validation and run through the
// same files.ValidateSegment gate the locator uses on serve, so escaped slashes
// (%2F), backslashes, NULs, and ".." cannot land in the DB even though they
// would already be rejected at serve time. Without this normalization a profile
// update could store junk URLs that confuse later UI/validation passes.
//
// Without the prefix gate, a profile-update caller could point their avatar at
// any /api/files/... URL — including private message attachments — and the
// server would sign and serve it on every egress as if it were the user's own.
func normalizeOwnAvatarURL(raw, userID string) (string, error) {
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("avatar_url is unparseable")
	}
	// Must be a relative path on this origin — reject https://evil.example/...
	// or //attacker.example/... that would otherwise prefix-match.
	if u.Scheme != "" || u.Host != "" || u.Opaque != "" {
		return "", fmt.Errorf("avatar_url must be a relative path on this server")
	}
	prefix := "/api/files/avatars/" + userID + "/"
	// Use the parsed (un-escaped) Path so a literal "/" smuggled via %2F
	// would already appear here and fail the prefix check. EscapedPath() would
	// hide it. Either form is fine for the prefix because userID is ASCII.
	if !strings.HasPrefix(u.Path, prefix) {
		return "", fmt.Errorf("avatar_url must be uploaded via /api/users/me/avatar")
	}
	rest := u.Path[len(prefix):]
	// rest is already percent-decoded by url.Parse. Run it through the same
	// segment validator the locator applies on serve.
	if err := files.ValidateSegment(rest); err != nil {
		return "", fmt.Errorf("avatar_url has invalid filename: %v", err)
	}
	// DB stores the unsigned canonical path. Re-escape so the stored URL
	// matches what the upload handler writes (url.PathEscape on the filename).
	return "/api/files/avatars/" + userID + "/" + url.PathEscape(rest), nil
}
