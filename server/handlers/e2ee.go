package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// E2EEHandler, E2EE anahtar yedekleme ve grup oturum yönetimi endpoint'lerini barındırır.
//
// Endpoint'ler:
// PUT    /api/e2ee/key-backup                                    — Şifreli anahtar yedeği yükle/güncelle
// GET    /api/e2ee/key-backup                                    — Şifreli anahtar yedeğini indir
// DELETE /api/e2ee/key-backup                                    — Anahtar yedeğini sil
// POST   /api/servers/{sId}/channels/{cId}/group-sessions        — Sender Key oturumu kaydet
// GET    /api/servers/{sId}/channels/{cId}/group-sessions        — Kanaldaki grup oturumlarını al
type E2EEHandler struct {
	e2eeService services.E2EEService
}

// NewE2EEHandler, constructor — E2EEHandler pointer döner.
func NewE2EEHandler(e2eeService services.E2EEService) *E2EEHandler {
	return &E2EEHandler{e2eeService: e2eeService}
}

// ─── Key Backup Endpoints ───

// UpsertKeyBackup, kullanıcının şifreli anahtar yedeğini oluşturur veya günceller.
// PUT /api/e2ee/key-backup
//
// Sunucu sadece opak blob saklar — recovery password'ü bilmez,
// anahtarları okuyamaz. Client-side PBKDF2 + AES-256-GCM ile şifreleme yapılır.
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

// GetKeyBackup, kullanıcının anahtar yedeğini döner.
// GET /api/e2ee/key-backup
//
// Backup yoksa 200 + null data döner (404 değil — backup opsiyoneldir).
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

// DeleteKeyBackup, kullanıcının anahtar yedeğini siler.
// DELETE /api/e2ee/key-backup
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

// ─── Group Session Endpoints ───

// CreateGroupSession, kanala Sender Key grup oturumu kaydeder.
// POST /api/servers/{serverId}/channels/{channelId}/group-sessions
//
// Her gönderici cihaz, kanal için bir outbound Sender Key session oluşturur.
// Session data opak blob'dur — sunucu içeriğini bilmez.
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

	// sender_device_id query param'dan alınır
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

// GetGroupSessions, kanaldaki tüm aktif grup oturumlarını döner.
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
