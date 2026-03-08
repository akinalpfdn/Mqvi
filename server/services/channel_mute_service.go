package services

import (
	"context"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// ChannelMuteService handles per-user channel mute/unmute.
// Expired mutes are lazily cleaned via WHERE filter in the repo layer.
type ChannelMuteService interface {
	MuteChannel(ctx context.Context, userID, channelID, serverID string, req *models.MuteChannelRequest) error
	UnmuteChannel(ctx context.Context, userID, channelID string) error
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}

type channelMuteService struct {
	repo repository.ChannelMuteRepository
}

func NewChannelMuteService(repo repository.ChannelMuteRepository) ChannelMuteService {
	return &channelMuteService{repo: repo}
}

func (s *channelMuteService) MuteChannel(ctx context.Context, userID, channelID, serverID string, req *models.MuteChannelRequest) error {
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

	return s.repo.Upsert(ctx, userID, channelID, serverID, mutedUntilStr)
}

func (s *channelMuteService) UnmuteChannel(ctx context.Context, userID, channelID string) error {
	return s.repo.Delete(ctx, userID, channelID)
}

func (s *channelMuteService) GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error) {
	return s.repo.GetMutedChannelIDs(ctx, userID)
}
