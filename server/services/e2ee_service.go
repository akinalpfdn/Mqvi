package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// E2EEService handles key backup and group session management.
//
// Key Backup: encrypted key backup/restore via recovery password.
// The server stores opaque blobs only — it never sees the recovery password.
//
// Group Session: server-side coordination of Sender Key group sessions.
// Session data is opaque to the server — stored and distributed only.
type E2EEService interface {
	UpsertKeyBackup(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error
	GetKeyBackup(ctx context.Context, userID string) (*models.E2EEKeyBackup, error)
	DeleteKeyBackup(ctx context.Context, userID string) error

	// UpsertGroupSession creates/updates a Sender Key group session.
	// Broadcasts "group_session_new" to channel members on success.
	UpsertGroupSession(ctx context.Context, channelID, userID, deviceID string, req *models.CreateGroupSessionRequest) error
	GetGroupSessions(ctx context.Context, channelID string) ([]models.ChannelGroupSession, error)
	DeleteGroupSessionsByChannel(ctx context.Context, channelID string) error
	DeleteGroupSessionsByUser(ctx context.Context, channelID, userID string) error
}

type e2eeService struct {
	backupRepo       repository.E2EEKeyBackupRepository
	groupSessionRepo repository.GroupSessionRepository
	hub              ws.Broadcaster
}

func NewE2EEService(
	backupRepo repository.E2EEKeyBackupRepository,
	groupSessionRepo repository.GroupSessionRepository,
	hub ws.Broadcaster,
) E2EEService {
	return &e2eeService{
		backupRepo:       backupRepo,
		groupSessionRepo: groupSessionRepo,
		hub:              hub,
	}
}

func (s *e2eeService) UpsertKeyBackup(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	if err := s.backupRepo.Upsert(ctx, userID, req); err != nil {
		return fmt.Errorf("failed to upsert key backup: %w", err)
	}
	return nil
}

func (s *e2eeService) GetKeyBackup(ctx context.Context, userID string) (*models.E2EEKeyBackup, error) {
	backup, err := s.backupRepo.GetByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get key backup: %w", err)
	}
	return backup, nil
}

func (s *e2eeService) DeleteKeyBackup(ctx context.Context, userID string) error {
	if err := s.backupRepo.Delete(ctx, userID); err != nil {
		return fmt.Errorf("failed to delete key backup: %w", err)
	}
	return nil
}

func (s *e2eeService) UpsertGroupSession(ctx context.Context, channelID, userID, deviceID string, req *models.CreateGroupSessionRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	if err := s.groupSessionRepo.Upsert(ctx, channelID, userID, deviceID, req); err != nil {
		return fmt.Errorf("failed to upsert group session: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpGroupSessionNew,
		Data: GroupSessionNewData{
			ChannelID:    channelID,
			SenderUserID: userID,
			SessionID:    req.SessionID,
		},
	})

	return nil
}

func (s *e2eeService) GetGroupSessions(ctx context.Context, channelID string) ([]models.ChannelGroupSession, error) {
	sessions, err := s.groupSessionRepo.GetByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get group sessions: %w", err)
	}
	if sessions == nil {
		sessions = []models.ChannelGroupSession{}
	}
	return sessions, nil
}

func (s *e2eeService) DeleteGroupSessionsByChannel(ctx context.Context, channelID string) error {
	if err := s.groupSessionRepo.DeleteByChannel(ctx, channelID); err != nil {
		return fmt.Errorf("failed to delete channel group sessions: %w", err)
	}
	return nil
}

func (s *e2eeService) DeleteGroupSessionsByUser(ctx context.Context, channelID, userID string) error {
	if err := s.groupSessionRepo.DeleteByUser(ctx, channelID, userID); err != nil {
		return fmt.Errorf("failed to delete user group sessions: %w", err)
	}
	return nil
}

// GroupSessionNewData is the payload for group_session_new events.
type GroupSessionNewData struct {
	ChannelID    string `json:"channel_id"`
	SenderUserID string `json:"sender_user_id"`
	SessionID    string `json:"session_id"`
}
