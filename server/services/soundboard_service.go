package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
	"github.com/google/uuid"
)

const (
	maxSoundDurationMs = 7000 // 7 seconds
	maxSoundsPerServer = 50
)

var soundAllowedMimeTypes = map[string]bool{
	"audio/mpeg":  true,
	"audio/ogg":   true,
	"audio/wav":   true,
	"audio/webm":  true,
	"audio/mp4":   true,
	"audio/x-m4a": true,
	"audio/aac":   true,
	"video/mp4":   true, // frontend extracts audio and converts to WAV before upload; kept as fallback
}

// VoiceStateGetter retrieves a user's current voice state.
type VoiceStateGetter interface {
	GetUserVoiceState(userID string) *models.VoiceState
	GetChannelParticipants(channelID string) []models.VoiceState
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
	locator   *files.Locator
	maxSize   int64
	urlSigner FileURLSigner
}

func NewSoundboardService(
	repo repository.SoundboardRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
	voice VoiceStateGetter,
	locator *files.Locator,
	maxSize int64,
	urlSigner FileURLSigner,
) SoundboardService {
	return &soundboardService{
		repo:      repo,
		userRepo:  userRepo,
		hub:       hub,
		voice:     voice,
		locator:   locator,
		maxSize:   maxSize,
		urlSigner: urlSigner,
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

	diskFilename, err := files.GenerateDiskFilename(header.Filename)
	if err != nil {
		return nil, err
	}

	relURL, err := s.locator.SaveFile(files.KindSoundboard, serverID, diskFilename, func(dst *os.File) error {
		if _, err := io.Copy(dst, file); err != nil {
			return fmt.Errorf("save file: %w", err)
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, files.ErrInvalidSegment) {
			return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
		}
		return nil, err
	}

	sound := &models.SoundboardSound{
		ID:         uuid.New().String(),
		ServerID:   serverID,
		Name:       strings.TrimSpace(req.Name),
		Emoji:      req.Emoji,
		FileURL:    relURL,
		FileSize:   header.Size,
		DurationMs: durationMs,
		UploadedBy: userID,
	}

	if err := s.repo.Create(ctx, sound); err != nil {
		s.locator.DeleteFromURL(relURL)
		return nil, fmt.Errorf("create sound record: %w", err)
	}

	// Fetch with joined user info
	created, err := s.repo.GetByID(ctx, sound.ID)
	if err != nil {
		return sound, nil
	}

	// Sign for broadcast — clients consume the URL directly from the event
	broadcast := *created
	broadcast.FileURL = s.urlSigner.SignURL(broadcast.FileURL)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpSoundboardCreate,
		Data: &broadcast,
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

	// Sign for broadcast
	broadcast := *updated
	broadcast.FileURL = s.urlSigner.SignURL(broadcast.FileURL)
	s.hub.BroadcastToServer(sound.ServerID, ws.Event{
		Op:   ws.OpSoundboardUpdate,
		Data: &broadcast,
	})

	return updated, nil
}

func (s *soundboardService) Delete(ctx context.Context, id string) error {
	sound, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return err
	}

	s.locator.DeleteFromURL(sound.FileURL)

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

	// Broadcast only to users in the same voice channel
	participants := s.voice.GetChannelParticipants(voiceState.ChannelID)
	userIDs := make([]string, 0, len(participants))
	for _, p := range participants {
		userIDs = append(userIDs, p.UserID)
	}

	s.hub.BroadcastToUsers(userIDs, ws.Event{
		Op: ws.OpSoundboardPlay,
		Data: models.SoundboardPlayEvent{
			SoundID:   sound.ID,
			SoundName: sound.Name,
			SoundURL:  s.urlSigner.SignURL(sound.FileURL),
			UserID:    userID,
			Username:  username,
			ServerID:  serverID,
			ChannelID: voiceState.ChannelID,
		},
	})

	return nil
}
