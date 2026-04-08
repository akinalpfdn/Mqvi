// Package handlers -- LiveKitWebhookHandler receives webhook events from LiveKit servers.
// Events (participant_joined, participant_left, etc.) are logged to app_logs
// for diagnosing voice disconnection issues. The disconnect_reason field on
// participant_left events is the primary diagnostic signal.
//
// Multi-instance: key/secret pairs are loaded from DB (all livekit_instances),
// decrypted with AES-256-GCM, then used to build a multi-key HMAC verifier.
package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
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

type LiveKitWebhookHandler struct {
	keyLoader     WebhookKeyLoader
	encryptionKey []byte // AES-256-GCM key for credential decryption
	appLogger     services.AppLogService
}

func NewLiveKitWebhookHandler(keyLoader WebhookKeyLoader, encryptionKey []byte, appLogger services.AppLogService) *LiveKitWebhookHandler {
	return &LiveKitWebhookHandler{
		keyLoader:     keyLoader,
		encryptionKey: encryptionKey,
		appLogger:     appLogger,
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

// logEvent writes relevant webhook events to app_logs.
// Only participant events are logged — room/track/egress events are noisy and less useful.
func (h *LiveKitWebhookHandler) logEvent(event *livekit.WebhookEvent) {
	eventType := event.GetEvent()

	switch eventType {
	case "participant_joined", "participant_left":
		// continue
	default:
		return
	}

	participant := event.GetParticipant()
	room := event.GetRoom()
	if participant == nil {
		return
	}

	identity := participant.GetIdentity()
	roomName := ""
	if room != nil {
		roomName = room.GetName()
	}

	ts := time.Unix(event.GetCreatedAt(), 0).UTC().Format("15:04:05")

	metadata := map[string]string{
		"livekit_event": eventType,
		"room":          roomName,
		"identity":      identity,
		"timestamp":     ts,
	}

	level := models.LogLevelInfo
	message := ""

	switch eventType {
	case "participant_joined":
		message = fmt.Sprintf("participant joined room %s", roomName)

	case "participant_left":
		reason := participant.GetDisconnectReason().String()
		metadata["disconnect_reason"] = reason
		message = fmt.Sprintf("participant left room %s (reason: %s)", roomName, reason)

		if participant.GetDisconnectReason() != livekit.DisconnectReason_CLIENT_INITIATED {
			level = models.LogLevelWarn
		}
	}

	userID := identity
	h.appLogger.Log(level, models.LogCategoryLiveKit, &userID, nil, message, metadata)
}
