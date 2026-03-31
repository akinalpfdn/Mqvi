package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
	"github.com/google/uuid"
)

const (
	maxSoundDurationMs = 7000 // 7 seconds
	maxSoundsPerServer = 50
	soundboardSubdir   = "soundboard"
)

var soundAllowedMimeTypes = map[string]bool{
	"audio/mpeg":  true,
	"audio/ogg":   true,
	"audio/wav":   true,
	"audio/webm":  true,
	"audio/mp4":   true,
	"audio/x-m4a": true,
	"audio/aac":   true,
}

// VoiceStateGetter retrieves a user's current voice state.
type VoiceStateGetter interface {
	GetUserVoiceState(userID string) *models.VoiceState
}

// SoundboardService manages soundboard sounds per server.
type SoundboardService interface {
	List(ctx context.Context, serverID string) ([]models.SoundboardSound, error)
	Get(ctx context.Context, id string) (*models.SoundboardSound, error)
	Create(ctx context.Context, serverID, userID string, req *models.CreateSoundboardSoundRequest, file multipart.File, header *multipart.FileHeader, durationMs int) (*models.SoundboardSound, error)
	Update(ctx context.Context, id string, req *models.UpdateSoundboardSoundRequest) (*models.SoundboardSound, error)
	Delete(ctx context.Context, id string) error
	Play(ctx context.Context, serverID, soundID, userID, username string) error
}

type soundboardService struct {
	repo      repository.SoundboardRepository
	userRepo  repository.UserRepository
	hub       ws.Broadcaster
	voice     VoiceStateGetter
	uploadDir string
	maxSize   int64
}

func NewSoundboardService(
	repo repository.SoundboardRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
	voice VoiceStateGetter,
	uploadDir string,
	maxSize int64,
) SoundboardService {
	// Ensure soundboard upload directory exists
	dir := filepath.Join(uploadDir, soundboardSubdir)
	os.MkdirAll(dir, 0o755)

	return &soundboardService{
		repo:      repo,
		userRepo:  userRepo,
		hub:       hub,
		voice:     voice,
		uploadDir: uploadDir,
		maxSize:   maxSize,
	}
}

func (s *soundboardService) List(ctx context.Context, serverID string) ([]models.SoundboardSound, error) {
	sounds, err := s.repo.ListByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("list soundboard sounds: %w", err)
	}
	if sounds == nil {
		sounds = []models.SoundboardSound{}
	}
	return sounds, nil
}

func (s *soundboardService) Get(ctx context.Context, id string) (*models.SoundboardSound, error) {
	return s.repo.GetByID(ctx, id)
}

func (s *soundboardService) Create(
	ctx context.Context,
	serverID, userID string,
	req *models.CreateSoundboardSoundRequest,
	file multipart.File,
	header *multipart.FileHeader,
	durationMs int,
) (*models.SoundboardSound, error) {
	if durationMs <= 0 || durationMs > maxSoundDurationMs {
		return nil, fmt.Errorf("%w: duration must be between 1 and %d ms", pkg.ErrBadRequest, maxSoundDurationMs)
	}

	if strings.TrimSpace(req.Name) == "" {
		return nil, fmt.Errorf("%w: name is required", pkg.ErrBadRequest)
	}

	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large", pkg.ErrBadRequest)
	}

	contentType := header.Header.Get("Content-Type")
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)
	if !soundAllowedMimeTypes[mimeBase] {
		return nil, fmt.Errorf("%w: audio file type not allowed: %s", pkg.ErrBadRequest, mimeBase)
	}

	count, err := s.repo.CountByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("count sounds: %w", err)
	}
	if count >= maxSoundsPerServer {
		return nil, fmt.Errorf("%w: server has reached the maximum of %d sounds", pkg.ErrBadRequest, maxSoundsPerServer)
	}

	// Save file to disk
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, fmt.Errorf("generate random filename: %w", err)
	}
	safeFilename := sanitizeFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename
	dir := filepath.Join(s.uploadDir, soundboardSubdir)
	destPath := filepath.Join(dir, diskFilename)

	destFile, err := os.Create(destPath)
	if err != nil {
		return nil, fmt.Errorf("create file: %w", err)
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, file); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("save file: %w", err)
	}

	sound := &models.SoundboardSound{
		ID:         uuid.New().String(),
		ServerID:   serverID,
		Name:       strings.TrimSpace(req.Name),
		Emoji:      req.Emoji,
		FileURL:    "/api/uploads/" + soundboardSubdir + "/" + diskFilename,
		FileSize:   header.Size,
		DurationMs: durationMs,
		UploadedBy: userID,
	}

	if err := s.repo.Create(ctx, sound); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("create sound record: %w", err)
	}

	// Fetch with joined user info
	created, err := s.repo.GetByID(ctx, sound.ID)
	if err != nil {
		return sound, nil
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpSoundboardCreate,
		Data: created,
	})

	return created, nil
}

func (s *soundboardService) Update(ctx context.Context, id string, req *models.UpdateSoundboardSoundRequest) (*models.SoundboardSound, error) {
	sound, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			return nil, fmt.Errorf("%w: name cannot be empty", pkg.ErrBadRequest)
		}
		sound.Name = name
	}
	if req.Emoji != nil {
		sound.Emoji = req.Emoji
	}

	if err := s.repo.Update(ctx, sound); err != nil {
		return nil, fmt.Errorf("update sound: %w", err)
	}

	updated, _ := s.repo.GetByID(ctx, id)
	if updated == nil {
		updated = sound
	}

	s.hub.BroadcastToServer(sound.ServerID, ws.Event{
		Op:   ws.OpSoundboardUpdate,
		Data: updated,
	})

	return updated, nil
}

func (s *soundboardService) Delete(ctx context.Context, id string) error {
	sound, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return err
	}

	// Delete file from disk
	if sound.FileURL != "" {
		relPath := strings.TrimPrefix(sound.FileURL, "/api/uploads/")
		diskPath := filepath.Join(s.uploadDir, relPath)
		os.Remove(diskPath)
	}

	if err := s.repo.Delete(ctx, id); err != nil {
		return fmt.Errorf("delete sound: %w", err)
	}

	s.hub.BroadcastToServer(sound.ServerID, ws.Event{
		Op:   ws.OpSoundboardDelete,
		Data: map[string]string{"id": id, "server_id": sound.ServerID},
	})

	return nil
}

func (s *soundboardService) Play(ctx context.Context, serverID, soundID, userID, username string) error {
	// User must be in a voice channel
	voiceState := s.voice.GetUserVoiceState(userID)
	if voiceState == nil {
		return fmt.Errorf("%w: you must be in a voice channel to play sounds", pkg.ErrBadRequest)
	}

	sound, err := s.repo.GetByID(ctx, soundID)
	if err != nil {
		return err
	}

	if sound.ServerID != serverID {
		return fmt.Errorf("%w: sound does not belong to this server", pkg.ErrBadRequest)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpSoundboardPlay,
		Data: models.SoundboardPlayEvent{
			SoundID:   sound.ID,
			SoundName: sound.Name,
			SoundURL:  sound.FileURL,
			UserID:    userID,
			Username:  username,
			ServerID:  serverID,
			ChannelID: voiceState.ChannelID,
		},
	})

	return nil
}
