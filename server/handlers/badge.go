// Package handlers -- BadgeHandler: badge CRUD and user-badge assignment endpoints.
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/services"
)

const badgeIconMaxSize = 2 << 20 // 2MB

// BadgeHandler handles badge management endpoints.
type BadgeHandler struct {
	badgeService services.BadgeService
	pipeline     services.UploadPipeline
}

// NewBadgeHandler creates a new BadgeHandler.
func NewBadgeHandler(badgeService services.BadgeService, pipeline services.UploadPipeline) *BadgeHandler {
	return &BadgeHandler{badgeService: badgeService, pipeline: pipeline}
}

// ListBadges handles GET /api/badges
func (h *BadgeHandler) ListBadges(w http.ResponseWriter, r *http.Request) {
	badges, err := h.badgeService.ListBadges(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}
	if badges == nil {
		badges = []models.Badge{}
	}
	pkg.JSON(w, http.StatusOK, badges)
}

// CreateBadge handles POST /api/badges
func (h *BadgeHandler) CreateBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.CreateBadgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	badge, err := h.badgeService.CreateBadge(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, badge)
}

// UpdateBadge handles PATCH /api/badges/{id}
func (h *BadgeHandler) UpdateBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	badgeID := r.PathValue("id")

	var req models.CreateBadgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	badge, err := h.badgeService.UpdateBadge(r.Context(), user.ID, badgeID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, badge)
}

// DeleteBadge handles DELETE /api/badges/{id}
func (h *BadgeHandler) DeleteBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	badgeID := r.PathValue("id")

	if err := h.badgeService.DeleteBadge(r.Context(), user.ID, badgeID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "badge deleted"})
}

// AssignBadge handles POST /api/badges/{id}/assign
func (h *BadgeHandler) AssignBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	badgeID := r.PathValue("id")

	var body struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.UserID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user_id is required")
		return
	}

	ub, err := h.badgeService.AssignBadge(r.Context(), user.ID, body.UserID, badgeID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, ub)
}

// UnassignBadge handles DELETE /api/badges/{id}/assign/{userId}
func (h *BadgeHandler) UnassignBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	badgeID := r.PathValue("id")
	targetUserID := r.PathValue("userId")

	if err := h.badgeService.UnassignBadge(r.Context(), user.ID, targetUserID, badgeID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "badge unassigned"})
}

// GetUserBadges handles GET /api/users/{userId}/badges
func (h *BadgeHandler) GetUserBadges(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")

	badges, err := h.badgeService.GetUserBadges(r.Context(), userID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	if badges == nil {
		badges = []models.UserBadge{}
	}

	pkg.JSON(w, http.StatusOK, badges)
}

// UploadBadgeIcon handles POST /api/badges/icon (multipart/form-data)
// Saves the icon image to disk and returns the URL path.
func (h *BadgeHandler) UploadBadgeIcon(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Only badge admin can upload icons
	if user.ID != services.BadgeAdminUserID {
		pkg.ErrorWithMessage(w, http.StatusForbidden, "only badge admin can upload icons")
		return
	}

	limitMultipartBody(w, r, badgeIconMaxSize, 1)
	if err := r.ParseMultipartForm(badgeIconMaxSize); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	file, header, err := r.FormFile("icon")
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "icon file is required")
		return
	}
	defer file.Close()

	// Validate MIME type
	mime := header.Header.Get("Content-Type")
	if !allowedBadgeIconMimes[mime] {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "only PNG, JPEG, GIF, WEBP, and SVG are allowed")
		return
	}

	if !strings.Contains(header.Filename, ".") {
		header.Filename += mimeToExt(mime)
	}
	stored, err := h.pipeline.Store(r.Context(), files.KindBadge, "global", file, header, badgeIconMaxSize)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, map[string]string{"url": stored.RelativeURL})
}

var allowedBadgeIconMimes = map[string]bool{
	"image/jpeg":    true,
	"image/png":     true,
	"image/gif":     true,
	"image/webp":    true,
	"image/svg+xml": true,
}

func mimeToExt(mime string) string {
	switch {
	case strings.Contains(mime, "png"):
		return ".png"
	case strings.Contains(mime, "jpeg"):
		return ".jpg"
	case strings.Contains(mime, "gif"):
		return ".gif"
	case strings.Contains(mime, "webp"):
		return ".webp"
	case strings.Contains(mime, "svg"):
		return ".svg"
	default:
		return ".png"
	}
}
