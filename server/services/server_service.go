// Package services — ServerService: sunucu ayarları iş mantığı.
//
// Sunucu bilgisi okuma ve güncelleme (isim, ikon).
// Güncelleme sonrasında tüm client'lara WS broadcast yapılır —
// sidebar'daki sunucu adı ve ikon anında güncellenir.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// ServerService, sunucu ayarları iş mantığı interface'i.
type ServerService interface {
	// Get, sunucu bilgisini döner.
	Get(ctx context.Context) (*models.Server, error)

	// Update, sunucu bilgisini günceller ve broadcast eder.
	Update(ctx context.Context, req *models.UpdateServerRequest) (*models.Server, error)

	// UpdateIcon, sunucu ikonunu günceller ve broadcast eder.
	// AvatarHandler tarafından çağrılır — icon_url doğrudan set edilir.
	UpdateIcon(ctx context.Context, iconURL string) (*models.Server, error)
}

type serverService struct {
	serverRepo repository.ServerRepository
	hub        ws.EventPublisher
}

// NewServerService, constructor.
func NewServerService(
	serverRepo repository.ServerRepository,
	hub ws.EventPublisher,
) ServerService {
	return &serverService{
		serverRepo: serverRepo,
		hub:        hub,
	}
}

func (s *serverService) Get(ctx context.Context) (*models.Server, error) {
	return s.serverRepo.Get(ctx)
}

func (s *serverService) Update(ctx context.Context, req *models.UpdateServerRequest) (*models.Server, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	server, err := s.serverRepo.Get(ctx)
	if err != nil {
		return nil, err
	}

	// Partial update: sadece non-nil field'ları güncelle
	if req.Name != nil {
		server.Name = *req.Name
	}
	if req.InviteRequired != nil {
		server.InviteRequired = *req.InviteRequired
	}

	if err := s.serverRepo.Update(ctx, server); err != nil {
		return nil, fmt.Errorf("failed to update server: %w", err)
	}

	// Tüm client'lara broadcast — sidebar header anında güncellenir
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpServerUpdate,
		Data: server,
	})

	return server, nil
}

func (s *serverService) UpdateIcon(ctx context.Context, iconURL string) (*models.Server, error) {
	server, err := s.serverRepo.Get(ctx)
	if err != nil {
		return nil, err
	}

	server.IconURL = &iconURL

	if err := s.serverRepo.Update(ctx, server); err != nil {
		return nil, fmt.Errorf("failed to update server icon: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpServerUpdate,
		Data: server,
	})

	return server, nil
}
