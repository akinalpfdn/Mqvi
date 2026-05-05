package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// StorageService enforces per-user storage quotas.
type StorageService interface {
	// Reserve checks quota and atomically reserves bytes for an upload.
	// Returns pkg.ErrQuotaExceeded (413) if the user would exceed their quota.
	Reserve(ctx context.Context, userID string, bytes int64) error

	// Release gives back bytes (file deletion).
	Release(ctx context.Context, userID string, bytes int64) error

	// GetUsage returns the user's current storage state.
	GetUsage(ctx context.Context, userID string) (*repository.UserStorage, error)

	// SetQuota updates the quota for a user (admin).
	SetQuota(ctx context.Context, userID string, quotaBytes int64) error
}

type storageService struct {
	repo         repository.StorageRepository
	defaultQuota int64
}

func NewStorageService(repo repository.StorageRepository, defaultQuota int64) StorageService {
	return &storageService{
		repo:         repo,
		defaultQuota: defaultQuota,
	}
}

func (s *storageService) Reserve(ctx context.Context, userID string, bytes int64) error {
	ok, err := s.repo.TryIncrement(ctx, userID, bytes, s.defaultQuota)
	if err != nil {
		return fmt.Errorf("storage reserve: %w", err)
	}
	if !ok {
		return pkg.ErrQuotaExceeded
	}
	return nil
}

func (s *storageService) Release(ctx context.Context, userID string, bytes int64) error {
	return s.repo.Decrement(ctx, userID, bytes)
}

func (s *storageService) GetUsage(ctx context.Context, userID string) (*repository.UserStorage, error) {
	return s.repo.GetOrCreate(ctx, userID, s.defaultQuota)
}

func (s *storageService) SetQuota(ctx context.Context, userID string, quotaBytes int64) error {
	return s.repo.SetQuota(ctx, userID, quotaBytes)
}
