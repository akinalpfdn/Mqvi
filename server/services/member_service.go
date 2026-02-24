// Package services — MemberService: üye yönetimi iş mantığı.
//
// Bu service, üye listesi, profil güncelleme, rol atama,
// kick ve ban işlemlerinin tüm business logic'ini içerir.
//
// Kritik güvenlik kuralı — Rol Hiyerarşisi:
// Discord'da olduğu gibi, bir kullanıcı sadece kendisinden
// düşük position'daki rolleri ve kullanıcıları yönetebilir.
// Bu kural tüm mutating operasyonlarda (ModifyRoles, Kick, Ban) enforced edilir.
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
type MemberService interface {
	// GetAll, tüm üyeleri rolleriyle birlikte döner.
	GetAll(ctx context.Context) ([]models.MemberWithRoles, error)

	// GetByID, belirli bir üyeyi rolleriyle birlikte döner.
	GetByID(ctx context.Context, userID string) (*models.MemberWithRoles, error)

	// UpdateProfile, kullanıcının kendi profilini günceller.
	UpdateProfile(ctx context.Context, userID string, req *models.UpdateProfileRequest) (*models.MemberWithRoles, error)

	// UpdatePresence, kullanıcının online durumunu günceller (WS presence event'i ile).
	UpdatePresence(ctx context.Context, userID string, status models.UserStatus) error

	// ModifyRoles, bir üyenin rollerini değiştirir (hiyerarşi kontrolü ile).
	ModifyRoles(ctx context.Context, actorID string, targetID string, roleIDs []string) (*models.MemberWithRoles, error)

	// Kick, bir üyeyi sunucudan çıkarır (hiyerarşi kontrolü ile).
	Kick(ctx context.Context, actorID string, targetID string) error

	// Ban, bir üyeyi yasaklar (hiyerarşi kontrolü ile).
	Ban(ctx context.Context, actorID string, targetID string, reason string) error

	// Unban, bir üyenin yasağını kaldırır.
	Unban(ctx context.Context, userID string) error

	// GetBans, tüm yasaklı üyeleri döner.
	GetBans(ctx context.Context) ([]models.Ban, error)

	// IsBanned, kullanıcının banlı olup olmadığını kontrol eder.
	IsBanned(ctx context.Context, userID string) (bool, error)
}

type memberService struct {
	userRepo repository.UserRepository
	roleRepo repository.RoleRepository
	banRepo  repository.BanRepository
	hub      ws.EventPublisher
}

// NewMemberService, MemberService implementasyonunu oluşturur.
//
// Constructor injection: Tüm dependency'ler dışarıdan alınır.
// hub (EventPublisher) ile WS broadcast yapılır — DB değişikliklerini
// gerçek zamanlı olarak tüm bağlı client'lara iletmek için.
func NewMemberService(
	userRepo repository.UserRepository,
	roleRepo repository.RoleRepository,
	banRepo repository.BanRepository,
	hub ws.EventPublisher,
) MemberService {
	return &memberService{
		userRepo: userRepo,
		roleRepo: roleRepo,
		banRepo:  banRepo,
		hub:      hub,
	}
}

func (s *memberService) GetAll(ctx context.Context) ([]models.MemberWithRoles, error) {
	users, err := s.userRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get all users: %w", err)
	}

	members := make([]models.MemberWithRoles, 0, len(users))
	for i := range users {
		roles, err := s.roleRepo.GetByUserID(ctx, users[i].ID)
		if err != nil {
			return nil, fmt.Errorf("failed to get roles for user %s: %w", users[i].ID, err)
		}
		members = append(members, models.ToMemberWithRoles(&users[i], roles))
	}

	return members, nil
}

func (s *memberService) GetByID(ctx context.Context, userID string) (*models.MemberWithRoles, error) {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	roles, err := s.roleRepo.GetByUserID(ctx, userID)
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

	// Partial update: sadece non-nil field'ları güncelle
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

	// Güncellenmiş member'ı al ve broadcast et
	member, err := s.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMemberUpdate,
		Data: member,
	})

	return member, nil
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

// ModifyRoles, bir üyenin rollerini değiştirir.
//
// Hiyerarşi kuralları:
// 1. Actor kendi üstündekini yönetemez (target position >= actor position → forbidden)
// 2. Actor kendisinden yüksek rol atayamaz (role position >= actor position → forbidden)
// 3. Mevcut roller ile hedef roller diff'lenir: eksikler eklenir, fazlalar çıkarılır
func (s *memberService) ModifyRoles(ctx context.Context, actorID string, targetID string, roleIDs []string) (*models.MemberWithRoles, error) {
	// Actor'un rollerini al ve en yüksek position'ı hesapla
	actorRoles, err := s.roleRepo.GetByUserID(ctx, actorID)
	if err != nil {
		return nil, fmt.Errorf("failed to get actor roles: %w", err)
	}
	actorMaxPos := models.HighestPosition(actorRoles)

	// Target'in rollerini al
	targetRoles, err := s.roleRepo.GetByUserID(ctx, targetID)
	if err != nil {
		return nil, fmt.Errorf("failed to get target roles: %w", err)
	}
	targetMaxPos := models.HighestPosition(targetRoles)

	// Owner kimlik bazlı koruma — owner'ın rolleri değiştirilemez
	if models.HasOwnerRole(targetRoles) {
		return nil, fmt.Errorf("%w: cannot modify the server owner's roles", pkg.ErrForbidden)
	}

	// Hiyerarşi kontrolü: üstündekini yönetemezsin
	if targetMaxPos >= actorMaxPos {
		return nil, fmt.Errorf("%w: cannot modify roles of a user with equal or higher role", pkg.ErrForbidden)
	}

	// Atanacak rolleri kontrol et: kendinden yüksek rol atayamazsın
	for _, roleID := range roleIDs {
		role, err := s.roleRepo.GetByID(ctx, roleID)
		if err != nil {
			return nil, fmt.Errorf("role %s not found: %w", roleID, err)
		}
		if role.Position >= actorMaxPos {
			return nil, fmt.Errorf("%w: cannot assign role '%s' with equal or higher position", pkg.ErrForbidden, role.Name)
		}
	}

	// Mevcut roller ile hedef roller arasında diff yap
	currentSet := make(map[string]bool, len(targetRoles))
	for _, r := range targetRoles {
		currentSet[r.ID] = true
	}

	targetSet := make(map[string]bool, len(roleIDs))
	for _, id := range roleIDs {
		targetSet[id] = true
	}

	// Eklenmesi gerekenler: target set'te var ama current set'te yok
	for _, id := range roleIDs {
		if !currentSet[id] {
			if err := s.roleRepo.AssignToUser(ctx, targetID, id); err != nil {
				return nil, fmt.Errorf("failed to assign role: %w", err)
			}
		}
	}

	// Çıkarılması gerekenler: current set'te var ama target set'te yok
	for _, r := range targetRoles {
		if !targetSet[r.ID] {
			// Sadece actor'dan düşük position'daki roller çıkarılabilir
			if r.Position >= actorMaxPos {
				continue // Üstündeki rolü çıkaramazsın, atla
			}
			if err := s.roleRepo.RemoveFromUser(ctx, targetID, r.ID); err != nil {
				return nil, fmt.Errorf("failed to remove role: %w", err)
			}
		}
	}

	// Güncellenmiş member'ı al ve broadcast et
	member, err := s.GetByID(ctx, targetID)
	if err != nil {
		return nil, err
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMemberUpdate,
		Data: member,
	})

	return member, nil
}

// Kick, bir üyeyi sunucudan çıkarır.
//
// Hiyerarşi: Actor position > Target position olmalı.
// İşlem: User silinir (FK cascade ile user_roles, sessions vb. de silinir).
// WS broadcast: member_leave event'i tüm client'lara iletilir.
func (s *memberService) Kick(ctx context.Context, actorID string, targetID string) error {
	if actorID == targetID {
		return fmt.Errorf("%w: cannot kick yourself", pkg.ErrBadRequest)
	}

	if err := s.checkHierarchy(ctx, actorID, targetID); err != nil {
		return err
	}

	if err := s.userRepo.Delete(ctx, targetID); err != nil {
		return fmt.Errorf("failed to kick user: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMemberLeave,
		Data: map[string]string{"user_id": targetID},
	})

	return nil
}

// Ban, bir üyeyi yasaklar.
//
// Akış:
// 1. Hiyerarşi kontrolü
// 2. Ban kaydı oluştur
// 3. Kullanıcıyı WS'den disconnect et (Hub.DisconnectUser)
// 4. member_leave broadcast
func (s *memberService) Ban(ctx context.Context, actorID string, targetID string, reason string) error {
	if actorID == targetID {
		return fmt.Errorf("%w: cannot ban yourself", pkg.ErrBadRequest)
	}

	if err := s.checkHierarchy(ctx, actorID, targetID); err != nil {
		return err
	}

	// Hedef kullanıcının bilgilerini al (ban kaydında username saklamak için)
	target, err := s.userRepo.GetByID(ctx, targetID)
	if err != nil {
		return fmt.Errorf("failed to get target user: %w", err)
	}

	ban := &models.Ban{
		UserID:   targetID,
		Username: target.Username,
		Reason:   reason,
		BannedBy: actorID,
	}

	if err := s.banRepo.Create(ctx, ban); err != nil {
		return fmt.Errorf("failed to create ban: %w", err)
	}

	// WS'den disconnect et (Hub'ın DisconnectUser metodu EventPublisher'da)
	// Not: EventPublisher interface'inde DisconnectUser yok, bunu Hub'a eklememiz gerekiyor.
	// Şimdilik broadcast ile member_leave gönderiyoruz.

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMemberLeave,
		Data: map[string]string{"user_id": targetID},
	})

	return nil
}

func (s *memberService) Unban(ctx context.Context, userID string) error {
	return s.banRepo.Delete(ctx, userID)
}

func (s *memberService) GetBans(ctx context.Context) ([]models.Ban, error) {
	return s.banRepo.GetAll(ctx)
}

func (s *memberService) IsBanned(ctx context.Context, userID string) (bool, error) {
	return s.banRepo.Exists(ctx, userID)
}

// checkHierarchy, actor'un target üzerinde yetki sahibi olup olmadığını kontrol eder.
//
// Güvenlik katmanları:
// 1. Owner koruma — Owner rolüne sahip kullanıcı asla atılamaz/yasaklanamaz
// 2. Position kontrolü — Actor'un en yüksek position'ı target'ınkinden büyük olmalı
//
// Bu iki katmanlı (defense in depth) yaklaşım sayesinde:
// - Position manipülasyonu olsa bile owner korunur
// - Normal kullanıcılar arası hiyerarşi position ile enforced olur
func (s *memberService) checkHierarchy(ctx context.Context, actorID, targetID string) error {
	targetRoles, err := s.roleRepo.GetByUserID(ctx, targetID)
	if err != nil {
		return fmt.Errorf("failed to get target roles: %w", err)
	}

	// Katman 1: Owner kimlik bazlı koruma — hedef owner ise işlem reddedilir
	if models.HasOwnerRole(targetRoles) {
		return fmt.Errorf("%w: the server owner cannot be kicked or banned", pkg.ErrForbidden)
	}

	actorRoles, err := s.roleRepo.GetByUserID(ctx, actorID)
	if err != nil {
		return fmt.Errorf("failed to get actor roles: %w", err)
	}

	// Katman 2: Position bazlı hiyerarşi kontrolü
	actorMaxPos := models.HighestPosition(actorRoles)
	targetMaxPos := models.HighestPosition(targetRoles)

	if actorMaxPos <= targetMaxPos {
		return fmt.Errorf("%w: insufficient role hierarchy", pkg.ErrForbidden)
	}

	return nil
}
