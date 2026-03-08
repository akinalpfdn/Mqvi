package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// E2EEHandler handles E2EE key backup and group session management.
type E2EEHandler struct {
	e2eeService services.E2EEService
}

func NewE2EEHandler(e2eeService services.E2EEService) *E2EEHandler {
	return &E2EEHandler{e2eeService: e2eeService}
}

// ── Key Backup Endpoints ──

// UpsertKeyBackup creates or updates the user's encrypted key backup.
// Server stores an opaque blob -- cannot read the keys without the recovery password.
// PUT /api/e2ee/key-backup
func (h *E2EEHandler) UpsertKeyBackup(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req models.CreateKeyBackupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.e2eeService.UpsertKeyBackup(r.Context(), user.ID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, nil)
}

// GetKeyBackup returns the user's key backup.
// Returns 200 + null if no backup exists (backup is optional).
// GET /api/e2ee/key-backup
func (h *E2EEHandler) GetKeyBackup(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	backup, err := h.e2eeService.GetKeyBackup(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, backup)
}

// DeleteKeyBackup -- DELETE /api/e2ee/key-backup
func (h *E2EEHandler) DeleteKeyBackup(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	if err := h.e2eeService.DeleteKeyBackup(r.Context(), user.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, nil)
}

// ── Group Session Endpoints ──

// CreateGroupSession stores a Sender Key group session for a channel.
// Session data is an opaque blob -- server cannot read the contents.
// POST /api/servers/{serverId}/channels/{channelId}/group-sessions
func (h *E2EEHandler) CreateGroupSession(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	channelID := r.PathValue("channelId")
	if channelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	deviceID := r.URL.Query().Get("device_id")
	if deviceID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "device_id query param is required")
		return
	}

	var req models.CreateGroupSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.e2eeService.UpsertGroupSession(r.Context(), channelID, user.ID, deviceID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, nil)
}

// GetGroupSessions returns all active group sessions for a channel.
// GET /api/servers/{serverId}/channels/{channelId}/group-sessions
func (h *E2EEHandler) GetGroupSessions(w http.ResponseWriter, r *http.Request) {
	_, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	channelID := r.PathValue("channelId")
	if channelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	sessions, err := h.e2eeService.GetGroupSessions(r.Context(), channelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, sessions)
}
