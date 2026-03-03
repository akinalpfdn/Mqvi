// Package services — DMSettingsService: DM kanal ayarları iş mantığı.
//
// Kullanıcı bazlı DM kanal ayarları: gizleme, sabitleme, sessize alma.
// Her işlem UPSERT pattern kullanır — satır yoksa oluşturulur, varsa güncellenir.
//
// Auto-unhide: Hidden DM'e yeni mesaj geldiğinde otomatik olarak is_hidden=false yapılır.
// Bu metod dmService tarafından çağrılır (ISP: DMSettingsUnhider interface).
//
// WS broadcast: Ayar değişikliklerinde her iki DM katılımcısına bildirim gönderilir,
// böylece diğer tab'lar/cihazlar da güncellenir.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// DMSettingsService, DM kanal ayarları iş mantığı.
type DMSettingsService interface {
	// HideDM, DM'yi sidebar'dan gizler.
	HideDM(ctx context.Context, userID, channelID string) error

	// UnhideDM, DM'yi sidebar'da tekrar gösterir.
	UnhideDM(ctx context.Context, userID, channelID string) error

	// PinDM, DM'yi listenin en üstüne sabitler.
	PinDM(ctx context.Context, userID, channelID string) error

	// UnpinDM, DM'nin sabitlemesini kaldırır.
	UnpinDM(ctx context.Context, userID, channelID string) error

	// MuteDM, DM'yi sessize alır (süreli veya sonsuz).
	MuteDM(ctx context.Context, userID, channelID string, mutedUntil *string) error

	// UnmuteDM, DM'nin sessize alınmasını kaldırır.
	UnmuteDM(ctx context.Context, userID, channelID string) error

	// GetDMSettings, kullanıcının pinned + muted DM ID'lerini döner (initial load).
	GetDMSettings(ctx context.Context, userID string) (*DMSettingsResponse, error)

	// UnhideForNewMessage, hidden DM'e yeni mesaj geldiğinde otomatik unhide yapar.
	// dmService tarafından çağrılır — ISP: DMSettingsUnhider interface ile kullanılır.
	UnhideForNewMessage(ctx context.Context, userID, channelID string) error
}

// DMSettingsUnhider, dmService'in ihtiyaç duyduğu minimal interface (ISP).
// Yeni mesaj geldiğinde hidden DM'yi otomatik göstermek için kullanılır.
type DMSettingsUnhider interface {
	UnhideForNewMessage(ctx context.Context, userID, channelID string) error
}

// DMSettingsResponse, initial load için pinned + muted DM ID'leri.
type DMSettingsResponse struct {
	PinnedChannelIDs []string `json:"pinned_channel_ids"`
	MutedChannelIDs  []string `json:"muted_channel_ids"`
}

type dmSettingsService struct {
	settingsRepo repository.DMSettingsRepository
	dmRepo       repository.DMRepository
	hub          ws.Broadcaster
}

// NewDMSettingsService, constructor.
func NewDMSettingsService(
	settingsRepo repository.DMSettingsRepository,
	dmRepo repository.DMRepository,
	hub ws.Broadcaster,
) DMSettingsService {
	return &dmSettingsService{
		settingsRepo: settingsRepo,
		dmRepo:       dmRepo,
		hub:          hub,
	}
}

// verifyDMMembership, kullanıcının bu DM kanalının üyesi olduğunu doğrular.
func (s *dmSettingsService) verifyDMMembership(ctx context.Context, userID, channelID string) error {
	channel, err := s.dmRepo.GetChannelByID(ctx, channelID)
	if err != nil {
		return err
	}
	if channel.User1ID != userID && channel.User2ID != userID {
		return fmt.Errorf("%w: not a member of this DM channel", pkg.ErrForbidden)
	}
	return nil
}

// broadcastSettingsUpdate, ayar değişikliğini kullanıcının tüm bağlantılarına gönderir.
func (s *dmSettingsService) broadcastSettingsUpdate(userID, channelID, action string) {
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpDMSettingsUpdate,
		Data: map[string]string{
			"dm_channel_id": channelID,
			"action":        action,
		},
	})
}

// HideDM, DM'yi sidebar'dan gizler.
func (s *dmSettingsService) HideDM(ctx context.Context, userID, channelID string) error {
	if err := s.verifyDMMembership(ctx, userID, channelID); err != nil {
		return err
	}

	if err := s.settingsRepo.SetHidden(ctx, userID, channelID, true); err != nil {
		return fmt.Errorf("failed to hide DM: %w", err)
	}

	s.broadcastSettingsUpdate(userID, channelID, "hidden")
	return nil
}

// UnhideDM, DM'yi sidebar'da tekrar gösterir.
func (s *dmSettingsService) UnhideDM(ctx context.Context, userID, channelID string) error {
	if err := s.verifyDMMembership(ctx, userID, channelID); err != nil {
		return err
	}

	if err := s.settingsRepo.SetHidden(ctx, userID, channelID, false); err != nil {
		return fmt.Errorf("failed to unhide DM: %w", err)
	}

	s.broadcastSettingsUpdate(userID, channelID, "unhidden")
	return nil
}

// PinDM, DM'yi listenin en üstüne sabitler.
func (s *dmSettingsService) PinDM(ctx context.Context, userID, channelID string) error {
	if err := s.verifyDMMembership(ctx, userID, channelID); err != nil {
		return err
	}

	if err := s.settingsRepo.SetPinned(ctx, userID, channelID, true); err != nil {
		return fmt.Errorf("failed to pin DM: %w", err)
	}

	s.broadcastSettingsUpdate(userID, channelID, "pinned")
	return nil
}

// UnpinDM, DM'nin sabitlemesini kaldırır.
func (s *dmSettingsService) UnpinDM(ctx context.Context, userID, channelID string) error {
	if err := s.verifyDMMembership(ctx, userID, channelID); err != nil {
		return err
	}

	if err := s.settingsRepo.SetPinned(ctx, userID, channelID, false); err != nil {
		return fmt.Errorf("failed to unpin DM: %w", err)
	}

	s.broadcastSettingsUpdate(userID, channelID, "unpinned")
	return nil
}

// MuteDM, DM'yi sessize alır (süreli veya sonsuz — sentinel).
func (s *dmSettingsService) MuteDM(ctx context.Context, userID, channelID string, mutedUntil *string) error {
	if err := s.verifyDMMembership(ctx, userID, channelID); err != nil {
		return err
	}

	if err := s.settingsRepo.SetMutedUntil(ctx, userID, channelID, mutedUntil); err != nil {
		return fmt.Errorf("failed to mute DM: %w", err)
	}

	s.broadcastSettingsUpdate(userID, channelID, "muted")
	return nil
}

// UnmuteDM, DM'nin sessize alınmasını kaldırır.
func (s *dmSettingsService) UnmuteDM(ctx context.Context, userID, channelID string) error {
	if err := s.verifyDMMembership(ctx, userID, channelID); err != nil {
		return err
	}

	if err := s.settingsRepo.DeleteMute(ctx, userID, channelID); err != nil {
		return fmt.Errorf("failed to unmute DM: %w", err)
	}

	s.broadcastSettingsUpdate(userID, channelID, "unmuted")
	return nil
}

// GetDMSettings, initial load için pinned + muted DM ID'leri.
func (s *dmSettingsService) GetDMSettings(ctx context.Context, userID string) (*DMSettingsResponse, error) {
	pinned, err := s.settingsRepo.GetPinnedChannelIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pinned DM IDs: %w", err)
	}

	muted, err := s.settingsRepo.GetMutedChannelIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get muted DM IDs: %w", err)
	}

	if pinned == nil {
		pinned = []string{}
	}
	if muted == nil {
		muted = []string{}
	}

	return &DMSettingsResponse{
		PinnedChannelIDs: pinned,
		MutedChannelIDs:  muted,
	}, nil
}

// UnhideForNewMessage, hidden DM'e yeni mesaj geldiğinde otomatik unhide yapar.
// is_hidden=false UPSERT — satır yoksa bir şey yapmaz (UPSERT'te ON CONFLICT DO UPDATE).
// Hata loglama: mesaj gönderme akışını bloklamaz, sadece best-effort.
func (s *dmSettingsService) UnhideForNewMessage(ctx context.Context, userID, channelID string) error {
	if err := s.settingsRepo.SetHidden(ctx, userID, channelID, false); err != nil {
		return fmt.Errorf("failed to auto-unhide DM: %w", err)
	}

	s.broadcastSettingsUpdate(userID, channelID, "unhidden")
	return nil
}
