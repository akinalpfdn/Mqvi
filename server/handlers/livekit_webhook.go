// Package handlers -- LiveKitWebhookHandler receives webhook events from LiveKit servers.
//
// The handler observes; it does not act. Each participant_joined / participant_left is verified,
// classified, compared with where the voice service believes the user is, and written to
// app_logs. No voice state changes here. The fix for a backgrounded client being evicted is the
// SFU check in the orphan sweep (DECISIONS.md, 2026-09-07); what this handler records is how often
// the SFU and the server disagree, so that change can be sized from production before it lands.
//
// Multi-instance: key/secret pairs are loaded from DB (all livekit_instances), decrypted with
// AES-256-GCM, then used to build a multi-key HMAC verifier.
package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/services"

	"github.com/livekit/protocol/auth"
	livekit "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
)

// WebhookKeyLoader loads encrypted LiveKit credentials from DB.
// Returns ALL instances (not just platform-managed) so self-hosted instances
// can also send webhooks.
type WebhookKeyLoader interface {
	ListAllInstances(ctx context.Context) ([]models.LiveKitInstance, error)
}

// VoicePresenceReader is the one question this handler asks the voice service: where does the
// server think this user is? Read-only and in-memory (an RLock, no I/O), so it is safe on the
// request path LiveKit is waiting on. Consumer-side per ISP; nil disables the comparison.
type VoicePresenceReader interface {
	GetUserVoiceState(userID string) *models.VoiceState
}

// disconnectClass is what a participant_left reason would mean for voice state if anything acted
// on it. Nothing does. It is recorded so the distribution of reasons can be read from production.
// Unlisted values, including ones a newer LiveKit adds, fall to classIgnore — never to remove.
type disconnectClass string

const (
	// classRemove: an explicit hang-up, or the room no longer exists.
	classRemove disconnectClass = "remove"
	// classIgnore: the user is more connected than before (a newer session superseded this one),
	// LiveKit is moving them itself, the signal channel closed with media continuing, or this is
	// our own eviction echoing back — acting on that last one is a loop.
	classIgnore disconnectClass = "ignore"
	// classLogOnly: a reconnect usually follows, or the value is SIP/call-out semantics that do
	// not apply to voice channels. The SFU sweep decides.
	classLogOnly disconnectClass = "log_only"
)

func classifyDisconnect(r livekit.DisconnectReason) disconnectClass {
	switch r {
	case livekit.DisconnectReason_CLIENT_INITIATED,
		livekit.DisconnectReason_ROOM_DELETED,
		livekit.DisconnectReason_ROOM_CLOSED:
		return classRemove
	case livekit.DisconnectReason_DUPLICATE_IDENTITY,
		livekit.DisconnectReason_MIGRATION,
		livekit.DisconnectReason_PARTICIPANT_REMOVED,
		livekit.DisconnectReason_SIGNAL_CLOSE:
		return classIgnore
	case livekit.DisconnectReason_UNKNOWN_REASON,
		livekit.DisconnectReason_SERVER_SHUTDOWN,
		livekit.DisconnectReason_STATE_MISMATCH,
		livekit.DisconnectReason_JOIN_FAILURE,
		livekit.DisconnectReason_CONNECTION_TIMEOUT,
		livekit.DisconnectReason_MEDIA_FAILURE,
		livekit.DisconnectReason_USER_UNAVAILABLE,
		livekit.DisconnectReason_USER_REJECTED,
		livekit.DisconnectReason_SIP_TRUNK_FAILURE:
		return classLogOnly
	}
	return classIgnore
}

// Where the voice service believes the user is, relative to the room LiveKit named.
const (
	viewInChannel    = "in_channel"
	viewOtherChannel = "other_channel"
	viewNotInVoice   = "not_in_voice"
)

type LiveKitWebhookHandler struct {
	keyLoader     WebhookKeyLoader
	encryptionKey []byte // AES-256-GCM key for credential decryption
	appLogger     services.AppLogService
	presence      VoicePresenceReader
}

func NewLiveKitWebhookHandler(keyLoader WebhookKeyLoader, encryptionKey []byte, appLogger services.AppLogService, presence VoicePresenceReader) *LiveKitWebhookHandler {
	return &LiveKitWebhookHandler{
		keyLoader:     keyLoader,
		encryptionKey: encryptionKey,
		appLogger:     appLogger,
		presence:      presence,
	}
}

// HandleWebhook — POST /api/livekit/webhook
// No auth middleware — LiveKit signs the request with HMAC, verified via webhook.ReceiveWebhookEvent.
func (h *LiveKitWebhookHandler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	// Reject oversized bodies early — legitimate webhook payloads are <10KB
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)

	provider, err := h.buildKeyProvider(r.Context())
	if err != nil {
		log.Printf("[livekit-webhook] failed to load keys: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	event, err := webhook.ReceiveWebhookEvent(r, provider)
	if err != nil {
		log.Printf("[livekit-webhook] verification failed: %v", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	h.logEvent(event)

	w.WriteHeader(http.StatusOK)
}

// buildKeyProvider loads all LiveKit instance credentials from DB, decrypts them,
// and builds a multi-key provider. Webhook from any known instance verifies.
func (h *LiveKitWebhookHandler) buildKeyProvider(ctx context.Context) (auth.KeyProvider, error) {
	instances, err := h.keyLoader.ListAllInstances(ctx)
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}

	keys := make(map[string]string, len(instances))
	for _, inst := range instances {
		apiKey, err := crypto.Decrypt(inst.APIKey, h.encryptionKey)
		if err != nil {
			log.Printf("[livekit-webhook] failed to decrypt key for instance %s: %v", inst.ID, err)
			continue
		}
		apiSecret, err := crypto.Decrypt(inst.APISecret, h.encryptionKey)
		if err != nil {
			log.Printf("[livekit-webhook] failed to decrypt secret for instance %s: %v", inst.ID, err)
			continue
		}
		keys[apiKey] = apiSecret
	}

	if len(keys) == 0 {
		return nil, fmt.Errorf("no LiveKit instances with valid credentials found")
	}

	return auth.NewFileBasedKeyProviderFromMap(keys), nil
}

// logEvent writes participant events to app_logs with their classification and the server's own
// view of the user, and returns without side effects for everything else. Room/track/egress events
// are noisy and not useful here.
func (h *LiveKitWebhookHandler) logEvent(event *livekit.WebhookEvent) {
	eventType := event.GetEvent()
	switch eventType {
	case webhook.EventParticipantJoined, webhook.EventParticipantLeft:
	default:
		return
	}

	participant := event.GetParticipant()
	if participant == nil {
		return
	}

	identity := participant.GetIdentity()
	userID, isScreenShare := services.SplitParticipantIdentity(identity)
	roomName := event.GetRoom().GetName()

	metadata := map[string]string{
		"livekit_event":   eventType,
		"room":            roomName,
		"identity":        identity,
		"timestamp":       time.Unix(event.GetCreatedAt(), 0).UTC().Format("15:04:05"),
		"is_screen_share": strconv.FormatBool(isScreenShare),
	}
	level := models.LogLevelInfo

	serverID, channelID, roomOK := services.ParseRoomName(roomName)
	if roomOK {
		metadata["server_id"] = serverID
		metadata["channel_id"] = channelID
	} else {
		// Not one of ours, or the wire format changed. Recorded loudly, acted on never.
		metadata["room_malformed"] = "true"
		level = models.LogLevelWarn
	}

	// The SFU's word against the server's. How often these disagree, and which way, is the
	// number the orphan-sweep change needs before it lands.
	view := ""
	if h.presence != nil && roomOK {
		view = h.serverView(userID, channelID)
		metadata["server_view"] = view
		metadata["mismatch"] = strconv.FormatBool(view != viewInChannel)
	}

	subject := "participant"
	if isScreenShare {
		subject = "screen share"
	}

	var message string
	switch eventType {
	case webhook.EventParticipantJoined:
		message = fmt.Sprintf("%s joined room %s", subject, roomName)
	case webhook.EventParticipantLeft:
		reason := participant.GetDisconnectReason()
		class := classifyDisconnect(reason)
		metadata["disconnect_reason"] = reason.String()
		metadata["reason_class"] = string(class)
		message = fmt.Sprintf("%s left room %s (reason: %s, class: %s)", subject, roomName, reason, class)
		if reason != livekit.DisconnectReason_CLIENT_INITIATED {
			level = models.LogLevelWarn
		}
	}
	if view != "" {
		message += " [server: " + view + "]"
	}

	log.Printf("[livekit-webhook] %s identity=%s", message, identity)
	h.appLogger.Log(level, models.LogCategoryLiveKit, &userID, nil, message, metadata)
}

// serverView compares the room LiveKit named with the channel the voice service has the user in.
// The screen-share suffix is already stripped, so a sub-participant resolves to its owner.
func (h *LiveKitWebhookHandler) serverView(userID, channelID string) string {
	state := h.presence.GetUserVoiceState(userID)
	switch {
	case state == nil:
		return viewNotInVoice
	case state.ChannelID == channelID:
		return viewInChannel
	default:
		return viewOtherChannel
	}
}
