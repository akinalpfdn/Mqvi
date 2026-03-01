// Package services — LiveKitAdminService, platform admin tarafından LiveKit instance yönetimi.
//
// Bu service platform-managed LiveKit instance'ların CRUD işlemlerini yönetir.
// Self-hosted instance'lar bu service'in kapsamı dışındadır — onlar ServerService üzerinden yönetilir.
//
// Credential'lar AES-256-GCM ile şifrelenir (pkg/crypto).
// Admin'e dönen view'larda credential'lar ASLA yer almaz.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/repository"
)

// LiveKitAdminService, platform admin'in LiveKit instance yönetimi için interface.
type LiveKitAdminService interface {
	// ListInstances, tüm platform-managed LiveKit instance'larını döner.
	// Credential'lar dönen view'da yer almaz.
	ListInstances(ctx context.Context) ([]models.LiveKitInstanceAdminView, error)

	// GetInstance, tek bir LiveKit instance'ı döner.
	GetInstance(ctx context.Context, instanceID string) (*models.LiveKitInstanceAdminView, error)

	// CreateInstance, yeni bir platform-managed LiveKit instance oluşturur.
	// Credential'lar AES-256-GCM ile şifrelenerek DB'ye yazılır.
	CreateInstance(ctx context.Context, req *models.CreateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error)

	// UpdateInstance, mevcut bir instance'ı günceller.
	// Optional alanlar — sadece gönderilen alanlar güncellenir.
	// Credential boş bırakılırsa mevcut değerler korunur.
	UpdateInstance(ctx context.Context, instanceID string, req *models.UpdateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error)

	// DeleteInstance, bir instance'ı siler.
	// Bağlı sunucular varsa targetInstanceID'ye migrate eder.
	// targetInstanceID boş ve serverCount > 0 ise hata döner.
	DeleteInstance(ctx context.Context, instanceID, targetInstanceID string) error
}

type livekitAdminService struct {
	livekitRepo   repository.LiveKitRepository
	encryptionKey []byte
}

// NewLiveKitAdminService, constructor — interface döner.
func NewLiveKitAdminService(livekitRepo repository.LiveKitRepository, encryptionKey []byte) LiveKitAdminService {
	return &livekitAdminService{
		livekitRepo:   livekitRepo,
		encryptionKey: encryptionKey,
	}
}

func (s *livekitAdminService) ListInstances(ctx context.Context) ([]models.LiveKitInstanceAdminView, error) {
	instances, err := s.livekitRepo.ListPlatformInstances(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list platform instances: %w", err)
	}

	views := make([]models.LiveKitInstanceAdminView, len(instances))
	for i, inst := range instances {
		views[i] = toAdminView(&inst)
	}

	return views, nil
}

func (s *livekitAdminService) GetInstance(ctx context.Context, instanceID string) (*models.LiveKitInstanceAdminView, error) {
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	view := toAdminView(inst)
	return &view, nil
}

func (s *livekitAdminService) CreateInstance(ctx context.Context, req *models.CreateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Credential'ları şifrele
	encKey, err := crypto.Encrypt(req.APIKey, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt api key: %w", err)
	}
	encSecret, err := crypto.Encrypt(req.APISecret, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt api secret: %w", err)
	}

	instance := &models.LiveKitInstance{
		URL:               req.URL,
		APIKey:            encKey,
		APISecret:         encSecret,
		IsPlatformManaged: true,
		ServerCount:       0,
		MaxServers:        req.MaxServers,
	}

	if err := s.livekitRepo.Create(ctx, instance); err != nil {
		return nil, fmt.Errorf("failed to create livekit instance: %w", err)
	}

	view := toAdminView(instance)
	return &view, nil
}

func (s *livekitAdminService) UpdateInstance(ctx context.Context, instanceID string, req *models.UpdateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Mevcut instance'ı getir
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	// Sadece platform-managed instance'lar güncellenebilir
	if !inst.IsPlatformManaged {
		return nil, fmt.Errorf("%w: only platform-managed instances can be updated via admin API", pkg.ErrForbidden)
	}

	// Optional alanları güncelle
	if req.URL != nil {
		inst.URL = *req.URL
	}
	if req.APIKey != nil {
		encKey, encErr := crypto.Encrypt(*req.APIKey, s.encryptionKey)
		if encErr != nil {
			return nil, fmt.Errorf("failed to encrypt api key: %w", encErr)
		}
		inst.APIKey = encKey
	}
	if req.APISecret != nil {
		encSecret, encErr := crypto.Encrypt(*req.APISecret, s.encryptionKey)
		if encErr != nil {
			return nil, fmt.Errorf("failed to encrypt api secret: %w", encErr)
		}
		inst.APISecret = encSecret
	}
	if req.MaxServers != nil {
		inst.MaxServers = *req.MaxServers
	}

	if err := s.livekitRepo.Update(ctx, inst); err != nil {
		return nil, fmt.Errorf("failed to update livekit instance: %w", err)
	}

	view := toAdminView(inst)
	return &view, nil
}

func (s *livekitAdminService) DeleteInstance(ctx context.Context, instanceID, targetInstanceID string) error {
	// Silinecek instance'ı getir
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return err
	}

	// Sadece platform-managed instance'lar silinebilir
	if !inst.IsPlatformManaged {
		return fmt.Errorf("%w: only platform-managed instances can be deleted via admin API", pkg.ErrForbidden)
	}

	// Bağlı sunucular varsa migration gerekli
	if inst.ServerCount > 0 {
		if targetInstanceID == "" {
			return fmt.Errorf("%w: instance has %d server(s), specify migrate_to target", pkg.ErrBadRequest, inst.ServerCount)
		}

		// Kendine migrate etme
		if targetInstanceID == instanceID {
			return fmt.Errorf("%w: cannot migrate to the same instance", pkg.ErrBadRequest)
		}

		// Hedef instance'ın varlığını kontrol et
		target, targetErr := s.livekitRepo.GetByID(ctx, targetInstanceID)
		if targetErr != nil {
			return fmt.Errorf("migration target not found: %w", targetErr)
		}

		// Hedef platform-managed olmalı
		if !target.IsPlatformManaged {
			return fmt.Errorf("%w: migration target must be a platform-managed instance", pkg.ErrBadRequest)
		}

		// Sunucuları taşı
		_, migrateErr := s.livekitRepo.MigrateServers(ctx, instanceID, targetInstanceID)
		if migrateErr != nil {
			return fmt.Errorf("failed to migrate servers: %w", migrateErr)
		}
	}

	// Instance'ı sil
	if err := s.livekitRepo.Delete(ctx, instanceID); err != nil {
		return fmt.Errorf("failed to delete livekit instance: %w", err)
	}

	return nil
}

// toAdminView, LiveKitInstance'ı credential'sız admin view'a dönüştürür.
func toAdminView(inst *models.LiveKitInstance) models.LiveKitInstanceAdminView {
	return models.LiveKitInstanceAdminView{
		ID:                inst.ID,
		URL:               inst.URL,
		IsPlatformManaged: inst.IsPlatformManaged,
		ServerCount:       inst.ServerCount,
		MaxServers:        inst.MaxServers,
		CreatedAt:         inst.CreatedAt,
	}
}
