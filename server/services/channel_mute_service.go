// Package services — ChannelMuteService: kanal sessize alma iş mantığı.
//
// Kullanıcı bazlı kanal mute/unmute ve muted kanal listesi.
// Mute süresi dolduğunda lazy olarak temizlenir (repo katmanında WHERE ile filtrelenir).
package services

import (
	"context"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// ChannelMuteService, kanal sessize alma iş mantığı interface'i.
type ChannelMuteService interface {
	// MuteChannel, kullanıcının belirli bir kanalı sessize almasını sağlar.
	MuteChannel(ctx context.Context, userID, channelID, serverID string, req *models.MuteChannelRequest) error

	// UnmuteChannel, kanal sessizliğini kaldırır.
	UnmuteChannel(ctx context.Context, userID, channelID string) error

	// GetMutedChannelIDs, kullanıcının aktif mute'lu kanal ID'lerini döner.
	// WS ready event'inde ve frontend'den çağrılır.
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}

type channelMuteService struct {
	repo repository.ChannelMuteRepository
}

// NewChannelMuteService, constructor — interface döner.
func NewChannelMuteService(repo repository.ChannelMuteRepository) ChannelMuteService {
	return &channelMuteService{repo: repo}
}

func (s *channelMuteService) MuteChannel(ctx context.Context, userID, channelID, serverID string, req *models.MuteChannelRequest) error {
	if err := req.Validate(); err != nil {
		return err
	}

	// Duration'ı *time.Time'a çevir, sonra SQLite uyumlu string'e dönüştür.
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
