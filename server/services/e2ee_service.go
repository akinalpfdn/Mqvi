package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// E2EEService, anahtar yedekleme ve grup oturum yönetimi iş mantığını tanımlar.
//
// İki ana sorumluluk:
// 1. Key Backup: Recovery password ile şifreli anahtar yedekleme/geri yükleme.
//    Sunucu sadece opak blob saklar — recovery password'ü bilmez.
// 2. Group Session: Sender Key grup oturumlarının sunucu tarafı koordinasyonu.
//    Oturum verileri sunucu tarafından okunamaz — sadece depolanır ve dağıtılır.
type E2EEService interface {
	// ─── Key Backup ───

	// UpsertKeyBackup, kullanıcının şifreli anahtar yedeğini oluşturur/günceller.
	UpsertKeyBackup(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error

	// GetKeyBackup, kullanıcının anahtar yedeğini döner. Yoksa nil döner.
	GetKeyBackup(ctx context.Context, userID string) (*models.E2EEKeyBackup, error)

	// DeleteKeyBackup, kullanıcının anahtar yedeğini siler.
	DeleteKeyBackup(ctx context.Context, userID string) error

	// ─── Group Sessions ───

	// UpsertGroupSession, kanaldaki Sender Key grup oturumunu oluşturur/günceller.
	// Başarılı kayıt sonrası kanal üyelerine "group_session_new" broadcast edilir.
	UpsertGroupSession(ctx context.Context, channelID, userID, deviceID string, req *models.CreateGroupSessionRequest) error

	// GetGroupSessions, kanaldaki tüm aktif grup oturumlarını döner.
	GetGroupSessions(ctx context.Context, channelID string) ([]models.ChannelGroupSession, error)

	// DeleteGroupSessionsByChannel, kanaldaki tüm grup oturumlarını siler (key rotation).
	DeleteGroupSessionsByChannel(ctx context.Context, channelID string) error

	// DeleteGroupSessionsByUser, kullanıcının kanaldaki oturumlarını siler.
	DeleteGroupSessionsByUser(ctx context.Context, channelID, userID string) error
}

// e2eeService, E2EEService interface'inin implementasyonu.
type e2eeService struct {
	backupRepo       repository.E2EEKeyBackupRepository
	groupSessionRepo repository.GroupSessionRepository
	hub              ws.Broadcaster
}

// NewE2EEService, constructor — E2EEService interface döner.
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

// ─── Key Backup ───

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

// ─── Group Sessions ───

func (s *e2eeService) UpsertGroupSession(ctx context.Context, channelID, userID, deviceID string, req *models.CreateGroupSessionRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	if err := s.groupSessionRepo.Upsert(ctx, channelID, userID, deviceID, req); err != nil {
		return fmt.Errorf("failed to upsert group session: %w", err)
	}

	// Kanal üyelerine bildirim — yeni Sender Key oturumu mevcut
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

// ─── WS Event Data Struct'ları ───

// GroupSessionNewData, group_session_new event payload'ı.
// Kanala yeni bir Sender Key oturumu eklendiğinde gönderilir.
type GroupSessionNewData struct {
	ChannelID    string `json:"channel_id"`
	SenderUserID string `json:"sender_user_id"`
	SessionID    string `json:"session_id"`
}
