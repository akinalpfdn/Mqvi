package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// MessageHandler, mesaj endpoint'lerini yöneten struct.
type MessageHandler struct {
	messageService services.MessageService
	uploadService  services.UploadService
	maxUploadSize  int64
}

// NewMessageHandler, constructor.
func NewMessageHandler(
	messageService services.MessageService,
	uploadService services.UploadService,
	maxUploadSize int64,
) *MessageHandler {
	return &MessageHandler{
		messageService: messageService,
		uploadService:  uploadService,
		maxUploadSize:  maxUploadSize,
	}
}

// List godoc
// GET /api/channels/{id}/messages?before=ID&limit=50
// Mesajları cursor-based pagination ile döner.
//
// Query parametreleri:
// - before: Bu mesaj ID'sinden önceki mesajları getir (boşsa en yenilerden başla)
// - limit: Kaç mesaj dönsün (default 50, max 100)
func (h *MessageHandler) List(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	beforeID := r.URL.Query().Get("before")

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	page, err := h.messageService.GetByChannelID(r.Context(), channelID, beforeID, limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, page)
}

// Create godoc
// POST /api/channels/{id}/messages
// Yeni mesaj gönderir. JSON veya multipart/form-data kabul eder.
//
// JSON body: { "content": "mesaj metni" }
// Multipart: content field + files field(ları)
func (h *MessageHandler) Create(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Content-Type'a göre parse et
	contentType := r.Header.Get("Content-Type")

	var req models.CreateMessageRequest

	if isMultipart(contentType) {
		// Multipart: dosya + metin içeren mesaj
		//
		// ParseMultipartForm nedir?
		// HTTP request body'sini multipart form olarak parse eder.
		// maxUploadSize parametresi bellek limitini belirler —
		// bu boyutu aşan dosyalar otomatik olarak geçici dosyaya yazılır.
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}

		req.Content = r.FormValue("content")
	} else {
		// JSON: sadece metin mesaj
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	// Mesajı oluştur
	message, err := h.messageService.Create(r.Context(), channelID, user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Multipart ise dosyaları yükle
	if isMultipart(contentType) && r.MultipartForm != nil {
		files := r.MultipartForm.File["files"]
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				continue // Açılamayan dosyayı atla
			}

			attachment, err := h.uploadService.Upload(r.Context(), message.ID, file, fileHeader)
			file.Close()
			if err != nil {
				continue // Yüklenemeyen dosyayı atla
			}

			message.Attachments = append(message.Attachments, *attachment)
		}
	}

	pkg.JSON(w, http.StatusCreated, message)
}

// Update godoc
// PATCH /api/messages/{id}
// Mesajı düzenler. Sadece mesaj sahibi düzenleyebilir.
func (h *MessageHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	message, err := h.messageService.Update(r.Context(), id, user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, message)
}

// Delete godoc
// DELETE /api/messages/{id}
// Mesajı siler. Mesaj sahibi VEYA MANAGE_MESSAGES yetkisi olan kullanıcılar silebilir.
func (h *MessageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Kullanıcının permission'larını al (context'ten veya başka yerden)
	// Şimdilik Permission context'i middleware'den geçiyor
	perms, _ := r.Context().Value(PermissionsContextKey).(models.Permission)

	if err := h.messageService.Delete(r.Context(), id, user.ID, perms); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "message deleted"})
}

// Upload godoc
// POST /api/upload
// Bağımsız dosya yükleme endpoint'i.
func (h *MessageHandler) Upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	messageID := r.FormValue("message_id")

	attachment, err := h.uploadService.Upload(r.Context(), messageID, file, header)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, attachment)
}

// PermissionsContextKey, context'te kullanıcının effective permission'larını taşır.
const PermissionsContextKey contextKey = "permissions"

// isMultipart, Content-Type'ın multipart/form-data olup olmadığını kontrol eder.
func isMultipart(contentType string) bool {
	return len(contentType) >= 19 && contentType[:19] == "multipart/form-data"
}
