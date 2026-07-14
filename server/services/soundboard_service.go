package services

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"mime/multipart"
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

// Soundboard uploads are WAV only: the client trims + encodes the selected
// (<=7s) segment to WAV before upload, so the server can measure the real
// duration from the WAV header and reject anything longer — instead of trusting
// the client-supplied duration. Other formats can't be cheaply duration-checked.
var soundAllowedMimeTypes = map[string]bool{
	"audio/wav":   true,
	"audio/x-wav": true,
	"audio/wave":  true,
}

// wavDurationMs computes a WAV's playback duration from its header (RIFF chunks),
// without decoding the audio. Returns an error if the stream isn't a parseable
// WAV. Rewinds the reader to the start before parsing.
func wavDurationMs(rs io.ReadSeeker) (int, error) {
	if _, err := rs.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	riff := make([]byte, 12)
	if _, err := io.ReadFull(rs, riff); err != nil {
		return 0, fmt.Errorf("read riff header: %w", err)
	}
	if string(riff[0:4]) != "RIFF" || string(riff[8:12]) != "WAVE" {
		return 0, fmt.Errorf("not a WAV file")
	}

	var byteRate, dataSize uint32
	var haveFmt, haveData bool
	hdr := make([]byte, 8)

	for {
		if _, err := io.ReadFull(rs, hdr); err != nil {
			break // EOF / truncated — stop scanning
		}
		id := string(hdr[0:4])
		size := binary.LittleEndian.Uint32(hdr[4:8])

		switch id {
		case "fmt ":
			// Bound the chunk size BEFORE allocating — a tiny file could declare a
			// huge fmt size and force a large allocation before ReadFull hits EOF.
			// A real PCM fmt chunk is 16 bytes (18/40 with extensions).
			if size < 16 || size > 4096 {
				return 0, fmt.Errorf("invalid fmt chunk size %d", size)
			}
			fmtData := make([]byte, size)
			if _, err := io.ReadFull(rs, fmtData); err != nil {
				return 0, fmt.Errorf("read fmt chunk: %w", err)
			}
			audioFormat := binary.LittleEndian.Uint16(fmtData[0:2])
			numChannels := binary.LittleEndian.Uint16(fmtData[2:4])
			sampleRate := binary.LittleEndian.Uint32(fmtData[4:8])
			storedByteRate := binary.LittleEndian.Uint32(fmtData[8:12])
			storedBlockAlign := binary.LittleEndian.Uint16(fmtData[12:14])
			bitsPerSample := binary.LittleEndian.Uint16(fmtData[14:16])

			// Reject implausible headers, then derive byteRate from the fields a
			// player actually uses (sampleRate × channels × bytesPerSample) instead
			// of trusting the stored byteRate — a crafted file could inflate that to
			// fake a short duration while shipping long PCM. Stored byteRate AND
			// blockAlign must match the derived values or the header is rejected.
			if audioFormat != 1 { // PCM only — what the client encodes
				return 0, fmt.Errorf("unsupported WAV format %d", audioFormat)
			}
			if numChannels < 1 || numChannels > 8 {
				return 0, fmt.Errorf("invalid channel count %d", numChannels)
			}
			if sampleRate < 8000 || sampleRate > 384000 {
				return 0, fmt.Errorf("invalid sample rate %d", sampleRate)
			}
			if bitsPerSample != 8 && bitsPerSample != 16 && bitsPerSample != 24 && bitsPerSample != 32 {
				return 0, fmt.Errorf("invalid bits per sample %d", bitsPerSample)
			}
			if storedBlockAlign != numChannels*(bitsPerSample/8) {
				return 0, fmt.Errorf("inconsistent WAV blockAlign")
			}
			byteRate = sampleRate * uint32(numChannels) * uint32(bitsPerSample/8)
			if storedByteRate != byteRate {
				return 0, fmt.Errorf("inconsistent WAV byteRate")
			}
			haveFmt = true
			if size%2 == 1 {
				if _, err := rs.Seek(1, io.SeekCurrent); err != nil {
					return 0, err
				}
			}
		case "data":
			dataSize = size
			haveData = true
		default:
			skip := int64(size)
			if size%2 == 1 {
				skip++
			}
			if _, err := rs.Seek(skip, io.SeekCurrent); err != nil {
				return 0, err
			}
		}
		if haveData {
			break // byteRate (from fmt) precedes data in canonical WAV
		}
	}

	if !haveFmt || !haveData || byteRate == 0 {
		return 0, fmt.Errorf("incomplete WAV header")
	}
	return int(float64(dataSize) / float64(byteRate) * 1000), nil
}

// VoiceStateGetter retrieves a user's current voice state.
type VoiceStateGetter interface {
	GetUserVoiceState(userID string) *models.VoiceState
	GetChannelParticipants(channelID string) []models.VoiceState
}

// ChannelPermissionResolver is the one thing the soundboard needs from the permission service:
// what this user may do in the channel they are about to make noise in. Satisfied by
// ChannelPermissionService.
type ChannelPermissionResolver interface {
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
}

// SoundboardService manages soundboard sounds per server.
type SoundboardService interface {
	List(ctx context.Context, serverID string) ([]models.SoundboardSound, error)
	Get(ctx context.Context, id string) (*models.SoundboardSound, error)
	Create(ctx context.Context, serverID, userID string, req *models.CreateSoundboardSoundRequest, file multipart.File, header *multipart.FileHeader, durationMs int) (*models.SoundboardSound, error)
	Update(ctx context.Context, serverID string, id string, req *models.UpdateSoundboardSoundRequest) (*models.SoundboardSound, error)
	Delete(ctx context.Context, serverID string, id string) error
	Play(ctx context.Context, serverID, soundID, userID, username string) error
}

type soundboardService struct {
	repo           repository.SoundboardRepository
	userRepo       repository.UserRepository
	hub            ws.Broadcaster
	voice          VoiceStateGetter
	channelPerms   ChannelPermissionResolver
	pipeline       UploadPipeline
	maxSize        int64
	urlSigner      FileURLSigner
	storageService StorageService
}

func NewSoundboardService(
	repo repository.SoundboardRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
	voice VoiceStateGetter,
	channelPerms ChannelPermissionResolver,
	pipeline UploadPipeline,
	maxSize int64,
	urlSigner FileURLSigner,
	storageService StorageService,
) SoundboardService {
	return &soundboardService{
		repo:           repo,
		userRepo:       userRepo,
		hub:            hub,
		voice:          voice,
		channelPerms:   channelPerms,
		pipeline:       pipeline,
		maxSize:        maxSize,
		urlSigner:      urlSigner,
		storageService: storageService,
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

	// Measure the real duration from the WAV header — never trust the client's
	// claimed duration_ms. Anything over the cap is rejected here, on the server.
	measuredMs, err := wavDurationMs(file)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid audio file (WAV required)", pkg.ErrBadRequest)
	}
	if measuredMs <= 0 || measuredMs > maxSoundDurationMs {
		return nil, fmt.Errorf("%w: sound must be at most %d ms", pkg.ErrBadRequest, maxSoundDurationMs)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind after duration check: %w", err)
	}
	durationMs = measuredMs // store the measured duration, not the client's claim

	count, err := s.repo.CountByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("count sounds: %w", err)
	}
	if count >= maxSoundsPerServer {
		return nil, fmt.Errorf("%w: server has reached the maximum of %d sounds", pkg.ErrBadRequest, maxSoundsPerServer)
	}

	stored, err := s.pipeline.Store(ctx, files.KindSoundboard, serverID, file, header, s.maxSize)
	if err != nil {
		return nil, err
	}

	sound := &models.SoundboardSound{
		ID:         uuid.New().String(),
		ServerID:   serverID,
		Name:       strings.TrimSpace(req.Name),
		Emoji:      req.Emoji,
		FileURL:    stored.RelativeURL,
		FileSize:   stored.Size,
		DurationMs: durationMs,
		UploadedBy: userID,
	}

	if err := s.repo.Create(ctx, sound); err != nil {
		s.pipeline.DeleteFromURL(stored.RelativeURL)
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

func (s *soundboardService) Update(ctx context.Context, serverID string, id string, req *models.UpdateSoundboardSoundRequest) (*models.SoundboardSound, error) {
	sound, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	// IDOR guard: the sound must belong to the route's server.
	if sound == nil || sound.ServerID != serverID {
		return nil, fmt.Errorf("%w: sound does not belong to this server", pkg.ErrForbidden)
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

func (s *soundboardService) Delete(ctx context.Context, serverID string, id string) error {
	sound, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return err
	}
	// IDOR guard: the sound must belong to the route's server.
	if sound == nil || sound.ServerID != serverID {
		return fmt.Errorf("%w: sound does not belong to this server", pkg.ErrForbidden)
	}

	s.pipeline.DeleteFromURL(sound.FileURL)

	if err := s.repo.Delete(ctx, id); err != nil {
		return fmt.Errorf("delete sound: %w", err)
	}

	// Release storage quota for the deleted sound file
	if sound.FileSize > 0 {
		if err := s.storageService.Release(ctx, sound.UploadedBy, sound.FileSize); err != nil {
			log.Printf("[soundboard] failed to release storage quota for user %s: %v", sound.UploadedBy, err)
		}
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

	// The permission belongs to the channel the sound comes OUT of, not the server it came from.
	// Membership of the sound's server is checked by the route; this is the only thing standing
	// between a sound and the voice channel it is about to be played into — and a user is
	// routinely in a voice channel of one server while looking at another, so the two are not
	// the same server. Resolved per channel so a channel override can revoke it on its own.
	perms, err := s.channelPerms.ResolveChannelPermissions(ctx, userID, voiceState.ChannelID)
	if err != nil {
		return fmt.Errorf("resolve soundboard permission in %s: %w", voiceState.ChannelID, err)
	}
	// Has(), not a raw mask: Admin bypasses every permission check in this codebase, and a bare
	// bit test would deny a server owner the soundboard the day the resolver stops expanding
	// Admin into PermAll for us.
	if !perms.Has(models.PermUseSoundboard) {
		return fmt.Errorf("%w: you cannot use the soundboard in this voice channel", pkg.ErrForbidden)
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
