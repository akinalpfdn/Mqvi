// Package services — RoleService: rol CRUD iş mantığı.
//
// Roller sunucudaki yetki gruplarını temsil eder.
// Her rolün bir position (hiyerarşi sırası), renk ve permission bitfield'ı vardır.
//
// Hiyerarşi kuralı:
// Bir kullanıcı sadece kendi en yüksek rolünden düşük position'daki
// rolleri oluşturabilir, düzenleyebilir veya silebilir.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// RoleService, rol yönetimi iş mantığı interface'i.
type RoleService interface {
	// GetAll, tüm rolleri döner (position DESC sıralı).
	GetAll(ctx context.Context) ([]models.Role, error)

	// Create, yeni rol oluşturur (hiyerarşi kontrolü ile).
	Create(ctx context.Context, actorID string, req *models.CreateRoleRequest) (*models.Role, error)

	// Update, mevcut rolü günceller (hiyerarşi kontrolü ile).
	Update(ctx context.Context, actorID string, roleID string, req *models.UpdateRoleRequest) (*models.Role, error)

	// Delete, rolü siler (hiyerarşi kontrolü + default rol koruması).
	Delete(ctx context.Context, actorID string, roleID string) error

	// ReorderRoles, rollerin sıralamasını toplu günceller (hiyerarşi kontrolü ile).
	// Actor sadece kendi en yüksek rolünden düşük position'daki rolleri sıralayabilir.
	// Default rol sıralama listesine dahil edilemez.
	ReorderRoles(ctx context.Context, actorID string, items []models.PositionUpdate) ([]models.Role, error)
}

type roleService struct {
	roleRepo repository.RoleRepository
	userRepo repository.UserRepository
	hub      ws.EventPublisher
}

// NewRoleService, RoleService implementasyonunu oluşturur.
func NewRoleService(
	roleRepo repository.RoleRepository,
	userRepo repository.UserRepository,
	hub ws.EventPublisher,
) RoleService {
	return &roleService{
		roleRepo: roleRepo,
		userRepo: userRepo,
		hub:      hub,
	}
}

func (s *roleService) GetAll(ctx context.Context) ([]models.Role, error) {
	return s.roleRepo.GetAll(ctx)
}

// Create, yeni rol oluşturur.
//
// Hiyerarşi kontrolü:
// - Actor'un en yüksek position'ı alınır
// - Yeni rolün position'ı actor'unkinden düşük olmalı
// - Position otomatik hesaplanır: actor position'ının hemen altı
func (s *roleService) Create(ctx context.Context, actorID string, req *models.CreateRoleRequest) (*models.Role, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Actor'un en yüksek position'ını al
	actorMaxPos, err := s.getActorMaxPosition(ctx, actorID)
	if err != nil {
		return nil, err
	}

	// Permission escalation kontrolü — actor sahip olmadığı yetkiyi yeni role veremez
	actorPerms, permErr := s.getActorEffectivePermissions(ctx, actorID)
	if permErr != nil {
		return nil, permErr
	}
	if !actorPerms.Has(models.PermAdmin) {
		escalated := req.Permissions &^ actorPerms
		if escalated != 0 {
			return nil, fmt.Errorf("%w: cannot grant permissions you do not have", pkg.ErrForbidden)
		}
	}

	// Yeni rolün position'ı: actor'un altında, mevcut rollerin en yükseğinin bir altı
	// Default olarak actor position - 1 kullanıyoruz (actor'un hemen altı)
	newPosition := actorMaxPos - 1
	if newPosition < 1 {
		newPosition = 1
	}

	role := &models.Role{
		Name:        req.Name,
		Color:       req.Color,
		Position:    newPosition,
		Permissions: req.Permissions,
	}

	if err := s.roleRepo.Create(ctx, role); err != nil {
		return nil, fmt.Errorf("failed to create role: %w", err)
	}

	// WS broadcast
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpRoleCreate,
		Data: role,
	})

	return role, nil
}

// Update, mevcut rolü günceller.
//
// Hiyerarşi kontrolü:
// - Güncellenecek rolün position'ı actor'unkinden düşük olmalı
// - Actor kendinden yüksek permission atayamaz (admin hariç)
func (s *roleService) Update(ctx context.Context, actorID string, roleID string, req *models.UpdateRoleRequest) (*models.Role, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	role, err := s.roleRepo.GetByID(ctx, roleID)
	if err != nil {
		return nil, err
	}

	// Owner rolü kimlik bazlı koruma — hiç kimse owner rolünü düzenleyemez
	if role.ID == models.OwnerRoleID {
		return nil, fmt.Errorf("%w: the Owner role cannot be modified", pkg.ErrForbidden)
	}

	// Hiyerarşi kontrolü
	actorMaxPos, err := s.getActorMaxPosition(ctx, actorID)
	if err != nil {
		return nil, err
	}

	if role.Position >= actorMaxPos {
		return nil, fmt.Errorf("%w: cannot modify a role with equal or higher position", pkg.ErrForbidden)
	}

	// Permission escalation kontrolü — actor sahip olmadığı yetkiyi veremez
	if req.Permissions != nil {
		actorPerms, permErr := s.getActorEffectivePermissions(ctx, actorID)
		if permErr != nil {
			return nil, permErr
		}
		newPerms := models.Permission(*req.Permissions)
		// Admin yetkisi olan actor tüm yetkileri atayabilir
		if !actorPerms.Has(models.PermAdmin) {
			// Yeni permission'larda actor'da olmayan bit var mı?
			escalated := newPerms &^ actorPerms
			if escalated != 0 {
				return nil, fmt.Errorf("%w: cannot grant permissions you do not have", pkg.ErrForbidden)
			}
		}
	}

	// Partial update
	if req.Name != nil {
		role.Name = *req.Name
	}
	if req.Color != nil {
		role.Color = *req.Color
	}
	if req.Permissions != nil {
		role.Permissions = *req.Permissions
	}

	if err := s.roleRepo.Update(ctx, role); err != nil {
		return nil, fmt.Errorf("failed to update role: %w", err)
	}

	// WS broadcast
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpRoleUpdate,
		Data: role,
	})

	return role, nil
}

// Delete, rolü siler.
//
// Güvenlik kontrolleri:
// 1. Default rol silinemez (her kullanıcıya atanır)
// 2. Rol position >= actor position → forbidden
func (s *roleService) Delete(ctx context.Context, actorID string, roleID string) error {
	role, err := s.roleRepo.GetByID(ctx, roleID)
	if err != nil {
		return err
	}

	// Owner rolü kimlik bazlı koruma
	if role.ID == models.OwnerRoleID {
		return fmt.Errorf("%w: the Owner role cannot be deleted", pkg.ErrForbidden)
	}

	if role.IsDefault {
		return fmt.Errorf("%w: cannot delete the default role", pkg.ErrBadRequest)
	}

	// Hiyerarşi kontrolü
	actorMaxPos, err := s.getActorMaxPosition(ctx, actorID)
	if err != nil {
		return err
	}

	if role.Position >= actorMaxPos {
		return fmt.Errorf("%w: cannot delete a role with equal or higher position", pkg.ErrForbidden)
	}

	if err := s.roleRepo.Delete(ctx, roleID); err != nil {
		return fmt.Errorf("failed to delete role: %w", err)
	}

	// WS broadcast
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpRoleDelete,
		Data: map[string]string{"id": roleID},
	})

	return nil
}

// ReorderRoles, rollerin sıralamasını toplu olarak günceller.
//
// Hiyerarşi kuralları:
// 1. Actor'un en yüksek position'ı alınır (actorMaxPos)
// 2. Sıralanan her rolün MEVCUT position'ı actorMaxPos'tan düşük olmalı
// 3. Sıralanan her rolün YENİ position'ı da actorMaxPos'tan düşük olmalı
// 4. Default rol (is_default=true) sıralama listesine dahil edilemez
// 5. Hiçbir rol actorMaxPos'a eşit veya üstüne taşınamaz
//
// Akış:
// 1. Actor hiyerarşi kontrolü
// 2. Her item: DB'den rolü çek, default/hiyerarşi kontrol
// 3. Repository'ye ilet — transaction ile atomik güncelleme
// 4. Güncel rol listesini DB'den yeniden yükle
// 5. WS broadcast — tüm client'lar güncel sırayı alır
func (s *roleService) ReorderRoles(ctx context.Context, actorID string, items []models.PositionUpdate) ([]models.Role, error) {
	if len(items) == 0 {
		return nil, fmt.Errorf("%w: items cannot be empty", pkg.ErrBadRequest)
	}

	// Actor'un en yüksek position'ını al
	actorMaxPos, err := s.getActorMaxPosition(ctx, actorID)
	if err != nil {
		return nil, err
	}

	// Her item için hiyerarşi ve default rol kontrolü
	for _, item := range items {
		role, err := s.roleRepo.GetByID(ctx, item.ID)
		if err != nil {
			return nil, err
		}

		// Owner rolü sıralanamaz — her zaman en üstte sabit
		if role.ID == models.OwnerRoleID {
			return nil, fmt.Errorf("%w: the Owner role cannot be reordered", pkg.ErrForbidden)
		}

		// Default rol sıralanamaz
		if role.IsDefault {
			return nil, fmt.Errorf("%w: cannot reorder the default role", pkg.ErrBadRequest)
		}

		// Mevcut position kontrolü: actor sadece kendinden düşük rolleri yönetebilir
		if role.Position >= actorMaxPos {
			return nil, fmt.Errorf("%w: cannot reorder a role with equal or higher position", pkg.ErrForbidden)
		}

		// Yeni position kontrolü: actor kendinden yükseğe taşıyamaz
		if item.Position >= actorMaxPos {
			return nil, fmt.Errorf("%w: cannot move a role to equal or higher position than your own", pkg.ErrForbidden)
		}
	}

	// Atomik güncelleme
	if err := s.roleRepo.UpdatePositions(ctx, items); err != nil {
		return nil, fmt.Errorf("failed to update role positions: %w", err)
	}

	// Güncel listeyi DB'den yeniden yükle
	roles, err := s.roleRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to reload roles after reorder: %w", err)
	}

	// WS broadcast — tüm client'lar güncel sırayı alır
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpRolesReorder,
		Data: roles,
	})

	return roles, nil
}

// getActorMaxPosition, actor kullanıcısının en yüksek rol position'ını döner.
func (s *roleService) getActorMaxPosition(ctx context.Context, actorID string) (int, error) {
	actorRoles, err := s.roleRepo.GetByUserID(ctx, actorID)
	if err != nil {
		return 0, fmt.Errorf("failed to get actor roles: %w", err)
	}

	return models.HighestPosition(actorRoles), nil
}

// getActorEffectivePermissions, actor kullanıcısının tüm rollerinin OR'lanmış
// effective permission'ını hesaplar.
// Permission escalation kontrolünde kullanılır — actor sahip olmadığı yetkiyi veremez.
func (s *roleService) getActorEffectivePermissions(ctx context.Context, actorID string) (models.Permission, error) {
	roles, err := s.roleRepo.GetByUserID(ctx, actorID)
	if err != nil {
		return 0, fmt.Errorf("failed to get actor roles: %w", err)
	}

	var perms models.Permission
	for _, r := range roles {
		perms |= r.Permissions
	}
	return perms, nil
}
