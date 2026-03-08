package services

import (
	"context"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// ServerMuteService handles per-user server mute/unmute.
// Expired mutes are lazily cleaned via WHERE filter in the repo layer.
type ServerMuteService interface {
	MuteServer(ctx context.Context, userID, serverID string, req *models.MuteServerRequest) error
	UnmuteServer(ctx context.Context, userID, serverID string) error
	GetMutedServerIDs(ctx context.Context, userID string) ([]string, error)
}

type serverMuteService struct {
	repo repository.ServerMuteRepository
}

func NewServerMuteService(repo repository.ServerMuteRepository) ServerMuteService {
	return &serverMuteService{repo: repo}
}

func (s *serverMuteService) MuteServer(ctx context.Context, userID, serverID string, req *models.MuteServerRequest) error {
	if err := req.Validate(); err != nil {
		return err
	}

	// Convert duration to SQLite-compatible timestamp string
	mutedUntil := req.ParseMutedUntil()
	var mutedUntilStr *string
	if mutedUntil != nil {
		s := mutedUntil.Format("2006-01-02 15:04:05")
		mutedUntilStr = &s
	}

	return s.repo.Upsert(ctx, userID, serverID, mutedUntilStr)
}

func (s *serverMuteService) UnmuteServer(ctx context.Context, userID, serverID string) error {
	return s.repo.Delete(ctx, userID, serverID)
}

func (s *serverMuteService) GetMutedServerIDs(ctx context.Context, userID string) ([]string, error) {
	return s.repo.GetMutedServerIDs(ctx, userID)
}
