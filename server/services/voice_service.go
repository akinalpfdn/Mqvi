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

// LiveKitInstanceGetter retrieves LiveKit instances. GetByID is needed because a channel stores
// the id it is bound to, not the credentials — see resolveRoomInstance.
type LiveKitInstanceGetter interface {
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
	GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error)
	// Only the routing question is needed here. Registering a server on an instance is somebody
	// else's job and answers to a different rule, so this interface does not see it.
	GetPlatformInstanceForRegion(ctx context.Context, region string) (*models.LiveKitInstance, error)
}

// ChannelBindingStore persists which instance a channel's room lives on. Separate from
// LiveKitInstanceGetter because it answers a different question — not "what is this instance" but
// "where is this call happening" — and only the restart path needs it.
//
// Optional: a nil store keeps the binding in memory only, which is correct behaviour with a single
// instance and is what the service tests run with.
type ChannelBindingStore interface {
	GetChannelBinding(ctx context.Context, channelID string) (string, error)
	SetChannelBinding(ctx context.Context, channelID, instanceID string) error
	ClearChannelBinding(ctx context.Context, channelID, instanceID string) error
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
	// RecordScreenShareFallback logs a client-side drop from the native capture path to the
	// browser one. Fire-and-forget: the share already succeeded, so nothing waits on this.
	RecordScreenShareFallback(userID, channelID, reason, detail string)
	// RecordNoiseReductionFailure logs a mic denoiser that would not attach on a client. Also
	// fire-and-forget: the call is unaffected, the user is just unfiltered.
	RecordNoiseReductionFailure(userID, channelID, engine, reason, detail string)
	JoinChannel(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) error
	LeaveChannel(userID string) error
	UpdateState(userID string, isMuted, isDeafened, isStreaming *bool, shareQuality *string) error
	UpdateUserProfile(userID, username, displayName, avatarURL string)
	GetChannelParticipants(channelID string) []models.VoiceState
	GetServerParticipants(serverID string) []models.VoiceState
	GetUserVoiceState(userID string) *models.VoiceState
	GetAllVoiceStates() []models.VoiceState
	GetActiveChannelTimers() map[string]int64 // channelID → start time (Unix ms)
	// SyncServerStatesToUser pushes a server's in-progress voice participants +
	// channel timers to one user (used on server join so a newcomer sees active
	// calls without reconnecting).
	SyncServerStatesToUser(userID, serverID string)
	// SetOnChannelEmpty installs a callback fired (in a goroutine) whenever the
	// channel transitions to zero participants. Used by voiceMessageService to
	// purge the ephemeral chat for that channel.
	SetOnChannelEmpty(fn func(channelID string))
	DisconnectUser(userID string)
	GetStreamCount(channelID string) int
	AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error
	MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error
	AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error
	// Live permission enforcement (S3): re-apply effective voice permissions at the SFU for
	// users already in voice after a permission-affecting change. Fire-and-forget.
	EnforceChannelVoicePermissions(channelID string)
	EnforceServerVoicePermissions(serverID string)
	EnforceUserVoicePermissions(userID string)
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
	StartLiveKitReconciliation()
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
	livekitAbsentSince map[string]time.Time          // userID -> first seen absent from the LiveKit room (reconcile grace)
	channelStartedAt   map[string]time.Time          // channelID -> moment the channel went from 0→1 participant
	channelInstances   map[string]string             // channelID -> LiveKit instance id, claimed by the first token request
	// channelID -> userID -> deadline. A token has been minted but the websocket join has not
	// arrived yet. Without this the channel looks empty during the LiveKit handshake, which both
	// leaks bindings (a token nobody uses pins the channel forever) and lets the last person
	// leaving release a binding out from under someone who is still connecting.
	pendingJoins map[string]map[string]time.Time
	onChannelEmpty     func(string)                  // optional callback fired (async) on N→0 — installed via SetOnChannelEmpty
	mu                 sync.RWMutex

	channelGetter    ChannelGetter
	livekitGetter    LiveKitInstanceGetter
	bindingStore     ChannelBindingStore
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
	bindingStore ChannelBindingStore,
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
		livekitAbsentSince: make(map[string]time.Time),
		channelStartedAt:   make(map[string]time.Time),
		channelInstances:   make(map[string]string),
		pendingJoins:       make(map[string]map[string]time.Time),
		channelGetter:      channelGetter,
		bindingStore:       bindingStore,
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

// SetOnChannelEmpty installs a callback fired (in a goroutine) on N→0 transitions.
// Set once at wiring time; not safe to call concurrently with voice operations.
func (s *voiceService) SetOnChannelEmpty(fn func(channelID string)) {
	s.onChannelEmpty = fn
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
