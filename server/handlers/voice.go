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
