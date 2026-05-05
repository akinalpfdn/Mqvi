// Package services — VoiceService interface, struct, and construction.
//
// Method implementations are split across concern-based files in this package:
//   voice_token.go       — LiveKit token generation (voice + screen share)
//   voice_state.go       — join/leave/update channel + state queries
//   voice_admin.go       — server mute/deafen, move, force-disconnect
//   voice_screenshare.go — screen share viewer tracking
//   voice_lifecycle.go   — orphan/AFK sweeps + LiveKit participant removal
//   voice_e2ee.go        — per-room SFrame passphrase helpers
//
// All files share the single `voiceService` struct and its single `sync.RWMutex`,
// so the concerns can cross-read each other's state without lock-ordering risk.
package services

import (
	"context"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/ws"
)

// ─── ISP Interfaces ───

// ChannelGetter retrieves channel info. Satisfied by repository.ChannelRepository.
type ChannelGetter interface {
	GetByID(ctx context.Context, id string) (*models.Channel, error)
}

// LiveKitInstanceGetter retrieves the LiveKit instance for a server.
type LiveKitInstanceGetter interface {
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
}

// OnlineUserChecker checks connected users. Used by orphan state cleanup.
type OnlineUserChecker interface {
	GetOnlineUserIDs() []string
}

// AFKTimeoutGetter retrieves a server's AFK timeout. Satisfied by repository.ServerRepository.
type AFKTimeoutGetter interface {
	GetByID(ctx context.Context, serverID string) (*models.Server, error)
}

// ─── VoiceService Interface ───

type VoiceService interface {
	GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	GenerateScreenShareToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	JoinChannel(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) error
	LeaveChannel(userID string) error
	UpdateState(userID string, isMuted, isDeafened, isStreaming *bool) error
	GetChannelParticipants(channelID string) []models.VoiceState
	GetUserVoiceState(userID string) *models.VoiceState
	GetAllVoiceStates() []models.VoiceState
	DisconnectUser(userID string)
	GetStreamCount(channelID string) int
	AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error
	MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error
	AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error
	// GetUserVoiceChannelID returns the user's active voice channel ID (empty if not in voice).
	// Satisfies UserVoiceChannelProvider for ChannelService sidebar visibility.
	GetUserVoiceChannelID(userID string) string
	WatchScreenShare(viewerUserID, streamerUserID string, watching bool)
	GetScreenShareViewerCount(streamerUserID string) int
	GetScreenShareStats() (streamers int, viewers int)
	CleanupViewersForStreamer(streamerUserID string)
	UpdateActivity(userID string)
	StartOrphanCleanup()
	StartAFKChecker()
	SetAppLogger(logger VoiceAppLogger)
}

// VoiceAppLogger writes structured logs. ISP interface to avoid importing services.AppLogService.
type VoiceAppLogger interface {
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

// forceMoveGrant is a one-time permission bypass for a force-moved user.
// Consumed by GenerateToken and expires after 30 seconds as a safety net.
type forceMoveGrant struct {
	channelID string
	expiresAt time.Time
}

// maxScreenShares caps simultaneous screen shares per voice channel.
// 0 disables the cap.
const maxScreenShares = 0

type voiceService struct {
	states             map[string]*models.VoiceState // userID -> VoiceState
	roomPassphrases    map[string]string             // roomName -> E2EE SFrame passphrase
	screenShareViewers map[string]map[string]bool    // streamerUserID -> set of viewerUserIDs
	forceMoveGrants    map[string]forceMoveGrant     // userID -> one-time bypass (consumed on token gen)
	offlineSince       map[string]time.Time          // userID -> first seen offline (grace period tracking)
	mu                 sync.RWMutex

	channelGetter    ChannelGetter
	livekitGetter    LiveKitInstanceGetter
	permResolver     ChannelPermResolver
	hub              ws.Broadcaster
	onlineChecker    OnlineUserChecker
	afkTimeoutGetter AFKTimeoutGetter
	encryptionKey    []byte // AES-256-GCM for LiveKit credential decryption
	appLogger        VoiceAppLogger
	urlSigner        FileURLSigner
}

func NewVoiceService(
	channelGetter ChannelGetter,
	livekitGetter LiveKitInstanceGetter,
	permResolver ChannelPermResolver,
	hub ws.Broadcaster,
	onlineChecker OnlineUserChecker,
	afkTimeoutGetter AFKTimeoutGetter,
	encryptionKey []byte,
	urlSigner FileURLSigner,
) VoiceService {
	return &voiceService{
		states:             make(map[string]*models.VoiceState),
		roomPassphrases:    make(map[string]string),
		screenShareViewers: make(map[string]map[string]bool),
		forceMoveGrants:    make(map[string]forceMoveGrant),
		offlineSince:       make(map[string]time.Time),
		channelGetter:      channelGetter,
		livekitGetter:      livekitGetter,
		permResolver:       permResolver,
		hub:                hub,
		onlineChecker:      onlineChecker,
		afkTimeoutGetter:   afkTimeoutGetter,
		encryptionKey:      encryptionKey,
		urlSigner:          urlSigner,
	}
}

func (s *voiceService) SetAppLogger(logger VoiceAppLogger) {
	s.appLogger = logger
}

// logError writes a structured error log if appLogger is set.
func (s *voiceService) logError(category models.LogCategory, userID *string, message string, metadata map[string]string) {
	if s.appLogger != nil {
		s.appLogger.Log(models.LogLevelError, category, userID, nil, message, metadata)
	}
}

// logWarn writes a structured warning log if appLogger is set.
func (s *voiceService) logWarn(category models.LogCategory, userID *string, message string, metadata map[string]string) {
	if s.appLogger != nil {
		s.appLogger.Log(models.LogLevelWarn, category, userID, nil, message, metadata)
	}
}
