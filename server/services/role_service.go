// Package services — RoleService: rol CRUD iş mantığı.
//
// Roller sunucudaki yetki gruplarını temsil eder.
// Her rolün bir position (hiyerarşi sırası), renk ve permission bitfield'ı vardır.
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

// RoleService, rol yönetimi iş mantığı interface'i.
// Tüm list operasyonları server-scoped.
type RoleService interface {
	GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error)
	Create(ctx context.Context, serverID, actorID string, req *models.CreateRoleRequest) (*models.Role, error)
	Update(ctx context.Context, serverID, actorID, roleID string, req *models.UpdateRoleRequest) (*models.Role, error)
	Delete(ctx context.Context, serverID, actorID, roleID string) error
	ReorderRoles(ctx context.Context, serverID, actorID string, items []models.PositionUpdate) ([]models.Role, error)
}

type roleService struct {
	roleRepo repository.RoleRepository
	userRepo repository.UserRepository
	hub      ws.EventPublisher
}

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

func (s *roleService) GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error) {
	return s.roleRepo.GetAllByServer(ctx, serverID)
}

func (s *roleService) Create(ctx context.Context, serverID, actorID string, req *models.CreateRoleRequest) (*models.Role, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Permission escalation kontrolü
	actorPerms, permErr := s.getActorEffectivePermissions(ctx, actorID, serverID)
	if permErr != nil {
		return nil, permErr
	}
	if !actorPerms.Has(models.PermAdmin) {
		escalated := req.Permissions &^ actorPerms
		if escalated != 0 {
			return nil, fmt.Errorf("%w: cannot grant permissions you do not have", pkg.ErrForbidden)
		}
	}

	allRoles, err := s.roleRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get all roles: %w", err)
	}

	// Member (default, position=1) hariç, tüm rollerin position'ını 1 artır
	var shifts []models.PositionUpdate
	for _, r := range allRoles {
		if r.IsDefault {
			continue
		}
		shifts = append(shifts, models.PositionUpdate{ID: r.ID, Position: r.Position + 1})
	}
	if len(shifts) > 0 {
		if err := s.roleRepo.UpdatePositions(ctx, shifts); err != nil {
			return nil, fmt.Errorf("failed to shift role positions: %w", err)
		}
	}

	newPosition := 2

	role := &models.Role{
		ServerID:    serverID,
		Name:        req.Name,
		Color:       req.Color,
		Position:    newPosition,
		Permissions: req.Permissions,
	}

	if err := s.roleRepo.Create(ctx, role); err != nil {
		return nil, fmt.Errorf("failed to create role: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpRoleCreate,
		Data: role,
	})

	return role, nil
}

func (s *roleService) Update(ctx context.Context, serverID, actorID, roleID string, req *models.UpdateRoleRequest) (*models.Role, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	role, err := s.roleRepo.GetByID(ctx, roleID)
	if err != nil {
		return nil, err
	}

	if role.ID == models.OwnerRoleID {
		return nil, fmt.Errorf("%w: the Owner role cannot be modified", pkg.ErrForbidden)
	}

	actorMaxPos, err := s.getActorMaxPosition(ctx, actorID, serverID)
	if err != nil {
		return nil, err
	}

	if role.Position >= actorMaxPos {
		return nil, fmt.Errorf("%w: cannot modify a role with equal or higher position", pkg.ErrForbidden)
	}

	if req.Permissions != nil {
		actorPerms, permErr := s.getActorEffectivePermissions(ctx, actorID, serverID)
		if permErr != nil {
			return nil, permErr
		}
		newPerms := models.Permission(*req.Permissions)
		if !actorPerms.Has(models.PermAdmin) {
			escalated := newPerms &^ actorPerms
			if escalated != 0 {
				return nil, fmt.Errorf("%w: cannot grant permissions you do not have", pkg.ErrForbidden)
			}
		}
	}

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

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpRoleUpdate,
		Data: role,
	})

	return role, nil
}

func (s *roleService) Delete(ctx context.Context, serverID, actorID, roleID string) error {
	role, err := s.roleRepo.GetByID(ctx, roleID)
	if err != nil {
		return err
	}

	if role.ID == models.OwnerRoleID {
		return fmt.Errorf("%w: the Owner role cannot be deleted", pkg.ErrForbidden)
	}

	if role.IsDefault {
		return fmt.Errorf("%w: cannot delete the default role", pkg.ErrBadRequest)
	}

	actorMaxPos, err := s.getActorMaxPosition(ctx, actorID, serverID)
	if err != nil {
		return err
	}

	if role.Position >= actorMaxPos {
		return fmt.Errorf("%w: cannot delete a role with equal or higher position", pkg.ErrForbidden)
	}

	if err := s.roleRepo.Delete(ctx, roleID); err != nil {
		return fmt.Errorf("failed to delete role: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpRoleDelete,
		Data: map[string]string{"id": roleID},
	})

	return nil
}

func (s *roleService) ReorderRoles(ctx context.Context, serverID, actorID string, items []models.PositionUpdate) ([]models.Role, error) {
	if len(items) == 0 {
		return nil, fmt.Errorf("%w: items cannot be empty", pkg.ErrBadRequest)
	}

	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get actor roles: %w", err)
	}
	actorMaxPos := models.HighestPosition(actorRoles)

	isOwner := models.HasOwnerRole(actorRoles)

	for _, item := range items {
		role, err := s.roleRepo.GetByID(ctx, item.ID)
		if err != nil {
			return nil, err
		}

		if role.ID == models.OwnerRoleID {
			return nil, fmt.Errorf("%w: the Owner role cannot be reordered", pkg.ErrForbidden)
		}

		if role.IsDefault {
			return nil, fmt.Errorf("%w: cannot reorder the default role", pkg.ErrBadRequest)
		}

		if !isOwner {
			if role.Position >= actorMaxPos {
				return nil, fmt.Errorf("%w: cannot reorder a role with equal or higher position", pkg.ErrForbidden)
			}
			if item.Position >= actorMaxPos {
				return nil, fmt.Errorf("%w: cannot move a role to equal or higher position than your own", pkg.ErrForbidden)
			}
		}
	}

	if err := s.roleRepo.UpdatePositions(ctx, items); err != nil {
		return nil, fmt.Errorf("failed to update role positions: %w", err)
	}

	roles, err := s.roleRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload roles after reorder: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpRolesReorder,
		Data: roles,
	})

	return roles, nil
}

func (s *roleService) getActorMaxPosition(ctx context.Context, actorID, serverID string) (int, error) {
	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return 0, fmt.Errorf("failed to get actor roles: %w", err)
	}
	return models.HighestPosition(actorRoles), nil
}

func (s *roleService) getActorEffectivePermissions(ctx context.Context, actorID, serverID string) (models.Permission, error) {
	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return 0, fmt.Errorf("failed to get actor roles: %w", err)
	}

	var perms models.Permission
	for _, r := range roles {
		perms |= r.Permissions
	}
	return perms, nil
}
