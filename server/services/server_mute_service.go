// Package services — ServerMuteService: sunucu sessize alma iş mantığı.
//
// Kullanıcı bazlı sunucu mute/unmute ve muted sunucu listesi.
// Mute süresi dolduğunda lazy olarak temizlenir (repo katmanında WHERE ile filtrelenir).
package services

import (
	"context"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// ServerMuteService, sunucu sessize alma iş mantığı interface'i.
type ServerMuteService interface {
	// MuteServer, kullanıcının belirli bir sunucuyu sessize almasını sağlar.
	MuteServer(ctx context.Context, userID, serverID string, req *models.MuteServerRequest) error

	// UnmuteServer, sunucu sessizliğini kaldırır.
	UnmuteServer(ctx context.Context, userID, serverID string) error

	// GetMutedServerIDs, kullanıcının aktif mute'lu sunucu ID'lerini döner.
	// WS ready event'inde ve frontend'den çağrılır.
	GetMutedServerIDs(ctx context.Context, userID string) ([]string, error)
}

type serverMuteService struct {
	repo repository.ServerMuteRepository
}

// NewServerMuteService, constructor — interface döner.
func NewServerMuteService(repo repository.ServerMuteRepository) ServerMuteService {
	return &serverMuteService{repo: repo}
}

func (s *serverMuteService) MuteServer(ctx context.Context, userID, serverID string, req *models.MuteServerRequest) error {
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

	return s.repo.Upsert(ctx, userID, serverID, mutedUntilStr)
}

func (s *serverMuteService) UnmuteServer(ctx context.Context, userID, serverID string) error {
	return s.repo.Delete(ctx, userID, serverID)
}

func (s *serverMuteService) GetMutedServerIDs(ctx context.Context, userID string) ([]string, error) {
	return s.repo.GetMutedServerIDs(ctx, userID)
}
