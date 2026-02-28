// Package services — MemberService: üye yönetimi iş mantığı.
//
// Bu service, üye listesi, profil güncelleme, rol atama,
// kick ve ban işlemlerinin tüm business logic'ini içerir.
// Tüm operasyonlar server-scoped.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// MemberService, üye yönetimi iş mantığı interface'i.
// Tüm operasyonlar server-scoped.
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
}

type memberService struct {
	userRepo   repository.UserRepository
	roleRepo   repository.RoleRepository
	banRepo    repository.BanRepository
	serverRepo repository.ServerRepository
	hub        ws.EventPublisher
}

func NewMemberService(
	userRepo repository.UserRepository,
	roleRepo repository.RoleRepository,
	banRepo repository.BanRepository,
	serverRepo repository.ServerRepository,
	hub ws.EventPublisher,
) MemberService {
	return &memberService{
		userRepo:   userRepo,
		roleRepo:   roleRepo,
		banRepo:    banRepo,
		serverRepo: serverRepo,
		hub:        hub,
	}
}

// GetAll, belirli bir sunucudaki tüm üyeleri rolleriyle birlikte döner.
// server_members tablosuyla JOIN yaparak sadece sunucu üyelerini getirir.
func (s *memberService) GetAll(ctx context.Context, serverID string) ([]models.MemberWithRoles, error) {
	users, err := s.userRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get all users: %w", err)
	}

	// Sadece sunucu üyelerini filtrele
	members := make([]models.MemberWithRoles, 0)
	for i := range users {
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
		members = append(members, models.ToMemberWithRoles(&users[i], roles))
	}

	return members, nil
}

func (s *memberService) GetByID(ctx context.Context, serverID, userID string) (*models.MemberWithRoles, error) {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles for user: %w", err)
	}

	member := models.ToMemberWithRoles(user, roles)
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

	if req.DisplayName != nil {
		user.DisplayName = req.DisplayName
	}
	if req.AvatarURL != nil {
		user.AvatarURL = req.AvatarURL
	}
	if req.CustomStatus != nil {
		user.CustomStatus = req.CustomStatus
	}
	if req.Language != nil {
		user.Language = *req.Language
	}

	if err := s.userRepo.Update(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to update user profile: %w", err)
	}

	// Profile güncelleme global — tüm sunuculara broadcast
	// serverID bilmiyoruz burada, global member update yap
	member := models.ToMemberWithRoles(user, nil)
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMemberUpdate,
		Data: &member,
	})

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

	s.hub.BroadcastToAll(ws.Event{
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

	// Sunucudan çıkar (üyelik + roller)
	if err := s.serverRepo.RemoveMember(ctx, serverID, targetID); err != nil {
		return fmt.Errorf("failed to kick user: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpMemberLeave,
		Data: map[string]string{
			"server_id": serverID,
			"user_id":   targetID,
		},
	})

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

	// Sunucudan çıkar
	_ = s.serverRepo.RemoveMember(ctx, serverID, targetID)

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpMemberLeave,
		Data: map[string]string{
			"server_id": serverID,
			"user_id":   targetID,
		},
	})

	return nil
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
