package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

// DMHandler, DM (Direct Messages) endpoint'lerini yöneten struct.
//
// Channel MessageHandler ile paralel yapı:
// - dmService: DM iş mantığı (mesaj CRUD, reaction, pin, search)
// - dmUploadService: DM dosya yükleme (disk save + DB record)
// - maxUploadSize: Multipart form parse bellek limiti
// - messageLimiter: Spam koruması — MessageHandler ile aynı instance paylaşılır.
type DMHandler struct {
	dmService       services.DMService
	dmUploadService services.DMUploadService
	maxUploadSize   int64
	messageLimiter  *ratelimit.MessageRateLimiter
}

// NewDMHandler, constructor.
func NewDMHandler(
	dmService services.DMService,
	dmUploadService services.DMUploadService,
	maxUploadSize int64,
	messageLimiter *ratelimit.MessageRateLimiter,
) *DMHandler {
	return &DMHandler{
		dmService:       dmService,
		dmUploadService: dmUploadService,
		maxUploadSize:   maxUploadSize,
		messageLimiter:  messageLimiter,
	}
}

// createDMChannelRequest, POST /api/dms body'si.
type createDMChannelRequest struct {
	UserID string `json:"user_id"`
}

// ListChannels godoc
// GET /api/dms
// Kullanıcının tüm DM kanallarını listeler (karşı taraf bilgisiyle).
func (h *DMHandler) ListChannels(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channels, err := h.dmService.ListChannels(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channels)
}

// CreateOrGetChannel godoc
// POST /api/dms
// İki kullanıcı arasındaki DM kanalını bul veya oluştur.
//
// Body: { "user_id": "target_user_id" }
// Response: DMChannelWithUser (karşı taraf bilgisiyle)
func (h *DMHandler) CreateOrGetChannel(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req createDMChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.UserID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user_id is required")
		return
	}

	channel, err := h.dmService.GetOrCreateChannel(r.Context(), user.ID, req.UserID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}

// GetMessages godoc
// GET /api/dms/{channelId}/messages?before=&limit=
// DM kanalının mesajlarını cursor-based pagination ile döner.
func (h *DMHandler) GetMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	beforeID := r.URL.Query().Get("before")
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	page, err := h.dmService.GetMessages(r.Context(), user.ID, channelID, beforeID, limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, page)
}

// SendMessage godoc
// POST /api/dms/{channelId}/messages
// Yeni bir DM mesajı gönderir.
//
// İki format desteklenir (channel MessageHandler.Create ile aynı pattern):
// 1. JSON: { "content": "mesaj", "reply_to_id": "xxx" }
// 2. Multipart: FormValue("content"), FormValue("reply_to_id"), File("files")
//
// Dosya yükleme akışı:
// 1. Service ile mesaj oluştur (DB'ye kaydet)
// 2. Multipart ise dosyaları yükle (dmUploadService.Upload)
// 3. Mesaja attachment'ları ekle
// 4. BroadcastCreate ile WS broadcast (attachment'lar dahil)
func (h *DMHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Spam koruması — MessageHandler ile aynı limiter instance.
	// Kullanıcı channel + DM toplam mesaj hızıyla sınırlanır.
	if h.messageLimiter != nil && !h.messageLimiter.Allow(user.ID) {
		retryAfter := h.messageLimiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many messages, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	contentType := r.Header.Get("Content-Type")
	var req models.CreateDMMessageRequest

	if isMultipart(contentType) {
		// Multipart: dosya + metin içeren mesaj
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}

		req.Content = r.FormValue("content")
		if replyTo := r.FormValue("reply_to_id"); replyTo != "" {
			req.ReplyToID = &replyTo
		}

		// E2EE alanları — multipart'tan parse
		if ev := r.FormValue("encryption_version"); ev == "1" {
			req.EncryptionVersion = 1
			if ct := r.FormValue("ciphertext"); ct != "" {
				req.Ciphertext = &ct
			}
			if sd := r.FormValue("sender_device_id"); sd != "" {
				req.SenderDeviceID = &sd
			}
			if em := r.FormValue("e2ee_metadata"); em != "" {
				req.E2EEMetadata = &em
			}
		}

		// Dosya var mı kontrol — HasFiles service'e iletilir (boş content kontrolü için)
		if r.MultipartForm != nil && len(r.MultipartForm.File["files"]) > 0 {
			req.HasFiles = true
		}
	} else {
		// JSON: sadece metin mesaj
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	// Mesajı oluştur
	msg, err := h.dmService.SendMessage(r.Context(), user.ID, channelID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Multipart ise dosyaları yükle
	if isMultipart(contentType) && r.MultipartForm != nil {
		isEncrypted := req.EncryptionVersion == 1
		files := r.MultipartForm.File["files"]
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				continue // Açılamayan dosyayı atla
			}

			attachment, err := h.dmUploadService.Upload(r.Context(), msg.ID, file, fileHeader, isEncrypted)
			file.Close()
			if err != nil {
				continue // Yüklenemeyen dosyayı atla
			}

			msg.Attachments = append(msg.Attachments, *attachment)
		}
	}

	// WS broadcast — dosya yükleme tamamlandıktan sonra
	h.dmService.BroadcastCreate(msg)

	pkg.JSON(w, http.StatusCreated, msg)
}

// EditMessage godoc
// PATCH /api/dms/messages/{id}
// DM mesajını düzenler (sadece mesaj sahibi).
func (h *DMHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateDMMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	msg, err := h.dmService.EditMessage(r.Context(), user.ID, messageID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, msg)
}

// DeleteMessage godoc
// DELETE /api/dms/messages/{id}
// DM mesajını siler (sadece mesaj sahibi).
func (h *DMHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.DeleteMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "message deleted"})
}

// ─── Reaction Endpoints ───

// ToggleReaction godoc
// POST /api/dms/messages/{id}/reactions
// DM mesajına emoji tepkisi ekler veya kaldırır (toggle).
//
// Body: { "emoji": "👍" }
func (h *DMHandler) ToggleReaction(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.ToggleDMReactionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.dmService.ToggleReaction(r.Context(), user.ID, messageID, req.Emoji); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ─── Pin Endpoints ───

// PinMessage godoc
// POST /api/dms/messages/{id}/pin
// DM mesajını sabitler.
func (h *DMHandler) PinMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.PinMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "pinned"})
}

// UnpinMessage godoc
// DELETE /api/dms/messages/{id}/pin
// DM mesajının sabitlemesini kaldırır.
func (h *DMHandler) UnpinMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.UnpinMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "unpinned"})
}

// GetPinnedMessages godoc
// GET /api/dms/{channelId}/pinned
// DM kanalının sabitlenmiş mesajlarını listeler.
func (h *DMHandler) GetPinnedMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	messages, err := h.dmService.GetPinnedMessages(r.Context(), user.ID, channelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, messages)
}

// ─── Search Endpoint ───

// SearchMessages godoc
// GET /api/dms/{channelId}/search?q=&limit=&offset=
// DM kanalında FTS5 tam metin araması yapar.
//
// Channel search handler ile aynı pattern — limit/offset query param'ları
// ile pagination destekler. DMSearchResult (messages + total_count) döner.
func (h *DMHandler) SearchMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		pkg.JSON(w, http.StatusOK, models.DMSearchResult{Messages: []models.DMMessage{}, TotalCount: 0})
		return
	}

	// Pagination parametreleri — channel search handler ile aynı pattern
	limit := 25
	offset := 0

	if v := r.URL.Query().Get("limit"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	result, err := h.dmService.SearchMessages(r.Context(), user.ID, channelID, query, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, result)
}

// PATCH /api/dms/{channelId}/e2ee
// DM kanalında E2EE'yi açar veya kapatır.
// Her iki kullanıcı da toggle yapabilir.
func (h *DMHandler) ToggleE2EE(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	channel, err := h.dmService.ToggleE2EE(r.Context(), user.ID, channelID, req.Enabled)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}
