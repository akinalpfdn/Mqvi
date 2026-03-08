package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// DMSettingsService manages per-user DM channel settings (hide, pin, mute).
// All operations use UPSERT. Auto-unhide: hidden DMs reappear on new message.
type DMSettingsService interface {
	HideDM(ctx context.Context, userID, channelID string) error
	UnhideDM(ctx context.Context, userID, channelID string) error
	PinDM(ctx context.Context, userID, channelID string) error
	UnpinDM(ctx context.Context, userID, channelID string) error
	MuteDM(ctx context.Context, userID, channelID string, mutedUntil *string) error
	UnmuteDM(ctx context.Context, userID, channelID string) error
	GetDMSettings(ctx context.Context, userID string) (*DMSettingsResponse, error)
	UnhideForNewMessage(ctx context.Context, userID, channelID string) error
}

// DMSettingsUnhider is the ISP interface used by dmService for auto-unhide on new message.
type DMSettingsUnhider interface {
	UnhideForNewMessage(ctx context.Context, userID, channelID string) error
}

type DMSettingsResponse struct {
	PinnedChannelIDs []string `json:"pinned_channel_ids"`
	MutedChannelIDs  []string `json:"muted_channel_ids"`
}

type dmSettingsService struct {
	settingsRepo repository.DMSettingsRepository
	dmRepo       repository.DMRepository
	hub          ws.Broadcaster
}

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

func (s *dmSettingsService) broadcastSettingsUpdate(userID, channelID, action string) {
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpDMSettingsUpdate,
		Data: map[string]string{
			"dm_channel_id": channelID,
			"action":        action,
		},
	})
}

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

// UnhideForNewMessage auto-unhides a DM when a new message arrives. Skips if not hidden.
func (s *dmSettingsService) UnhideForNewMessage(ctx context.Context, userID, channelID string) error {
	isHidden, err := s.settingsRepo.IsHidden(ctx, userID, channelID)
	if err != nil {
		return fmt.Errorf("failed to check DM hidden status: %w", err)
	}
	if !isHidden {
		return nil
	}

	if err := s.settingsRepo.SetHidden(ctx, userID, channelID, false); err != nil {
		return fmt.Errorf("failed to auto-unhide DM: %w", err)
	}

	s.broadcastSettingsUpdate(userID, channelID, "unhidden")
	return nil
}
