package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

// voiceHandlerService is the narrow subset of services.VoiceService that this
// handler actually uses. Defined here (consumer side) per ISP so tests can
// satisfy it with a tiny stub instead of the full VoiceService surface.
type voiceHandlerService interface {
	GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	GenerateScreenShareToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	RecordScreenShareFallback(userID, channelID, reason, detail string)
	GetAllVoiceStates() []models.VoiceState
}

type VoiceHandler struct {
	voiceService  voiceHandlerService
	urlSigner     services.FileURLSigner
	screenShareRL *ratelimit.MessageRateLimiter
}

func NewVoiceHandler(
	voiceService services.VoiceService,
	urlSigner services.FileURLSigner,
	screenShareRL *ratelimit.MessageRateLimiter,
) *VoiceHandler {
	return &VoiceHandler{voiceService: voiceService, urlSigner: urlSigner, screenShareRL: screenShareRL}
}

// Token handles POST /api/servers/{serverId}/voice/token
// Generates a LiveKit JWT for the server's LiveKit instance.
func (h *VoiceHandler) Token(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.VoiceTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.ChannelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	var displayName string
	if user.DisplayName != nil {
		displayName = *user.DisplayName
	}
	resp, err := h.voiceService.GenerateToken(r.Context(), user.ID, user.Username, displayName, req.ChannelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, resp)
}

// ScreenShareToken handles POST /api/servers/{serverId}/voice/screen-token
// Generates a LiveKit JWT for iOS native screen share (separate identity).
func (h *VoiceHandler) ScreenShareToken(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Gated BEFORE the service call, unlike the ICE handler which gates first and limits after.
	// Every outcome here costs something: a success mints a 4-hour JWT and may create the room's
	// E2EE passphrase, and a refusal writes an app_logs row. Limiting only the successes would
	// leave a member able to fill the screen_share log with refusals at request rate.
	//
	// Deliberately generous. The failure this logging exists to diagnose makes people retry, and a
	// tight bound would lock out exactly the users already suffering from it.
	if h.screenShareRL != nil && !h.screenShareRL.Allow(user.ID) {
		retryAfter := h.screenShareRL.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many screen share requests")
		return
	}

	var req models.VoiceTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.ChannelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	var displayName string
	if user.DisplayName != nil {
		displayName = *user.DisplayName
	}
	resp, err := h.voiceService.GenerateScreenShareToken(r.Context(), user.ID, user.Username, displayName, req.ChannelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, resp)
}

// ScreenShareFallback handles POST /api/servers/{serverId}/voice/screen-share-fallback
//
// The client reporting that "Akıcı Görüntü" could not start and it used "Net Görüntü" instead.
// Every step that can fail there runs on the user's machine — the helper is missing, the GPU has
// no encoder, the capture target vanished — so without this the operator cannot see it at all,
// and the user cannot be asked to fetch a log.
func (h *VoiceHandler) ScreenShareFallback(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Shares the screen-token bucket on purpose: one attempt costs one token and, if it fails, one
	// fallback report. Its own bucket would let a member write twice as many log rows as they can
	// make attempts.
	if h.screenShareRL != nil && !h.screenShareRL.Allow(user.ID) {
		retryAfter := h.screenShareRL.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many screen share requests")
		return
	}

	var req models.ScreenShareFallbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Closed set, not free text: this lands in app_logs, and an unvalidated reason would let any
	// member write arbitrary content into the operator's log and make it unscannable by cause.
	if !models.ScreenShareFallbackReasons[req.Reason] {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "unknown reason")
		return
	}

	detail := req.Detail
	if len(detail) > models.ScreenShareFallbackDetailMax {
		detail = detail[:models.ScreenShareFallbackDetailMax]
	}

	h.voiceService.RecordScreenShareFallback(user.ID, req.ChannelID, req.Reason, detail)
	w.WriteHeader(http.StatusNoContent)
}

// VoiceStates handles GET /api/servers/{serverId}/voice/states
// Returns active voice states scoped to the requested server only — leaking
// other servers' voice membership across server boundaries was the pre-existing
// behavior. Avatar URLs are stored unsigned in voice state (long-lived) and
// signed at egress so each consumer gets a fresh signature.
func (h *VoiceHandler) VoiceStates(w http.ResponseWriter, r *http.Request) {
	serverID := r.PathValue("serverId")
	if serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "serverId is required")
		return
	}
	all := h.voiceService.GetAllVoiceStates()
	out := make([]models.VoiceState, 0, len(all))
	for _, st := range all {
		if st.ServerID != serverID {
			continue
		}
		st.AvatarURL = h.urlSigner.SignURL(st.AvatarURL)
		out = append(out, st)
	}
	pkg.JSON(w, http.StatusOK, out)
}
