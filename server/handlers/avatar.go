// Package handlers -- AvatarHandler: user avatar and server icon upload endpoints.
//
// Separate from UploadService because avatar uploads update User/Server records
// directly (no messageID or Attachment record), and only image MIME types are accepted.
package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
)

const avatarMaxSize = 8 << 20 // 8MB

var allowedImageMimes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// AvatarHandler handles avatar and icon upload endpoints.
type AvatarHandler struct {
	userRepo      repository.UserRepository
	memberService services.MemberService
	serverService services.ServerService
	uploadDir     string
}

func NewAvatarHandler(
	userRepo repository.UserRepository,
	memberService services.MemberService,
	serverService services.ServerService,
	uploadDir string,
) *AvatarHandler {
	return &AvatarHandler{
		userRepo:      userRepo,
		memberService: memberService,
		serverService: serverService,
		uploadDir:     uploadDir,
	}
}

// UploadUserAvatar uploads the current user's avatar.
// Deletes the old avatar file from disk if present.
// POST /api/users/me/avatar (multipart/form-data)
func (h *AvatarHandler) UploadUserAvatar(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	fileURL, err := h.processUpload(r)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(user.AvatarURL)

	// Update via MemberService to get WS broadcast for free
	member, err := h.memberService.UpdateProfile(r.Context(), user.ID, &models.UpdateProfileRequest{
		AvatarURL: &fileURL,
	})
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// UploadUserWallpaper uploads the current user's wallpaper.
// Deletes the old wallpaper file from disk if present.
// POST /api/users/me/wallpaper (multipart/form-data)
func (h *AvatarHandler) UploadUserWallpaper(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	fileURL, err := h.processUpload(r)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(user.WallpaperURL)

	if err := h.userRepo.UpdateWallpaper(r.Context(), user.ID, &fileURL); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"wallpaper_url": fileURL})
}

// DeleteUserWallpaper removes the current user's wallpaper (file + DB column).
// DELETE /api/users/me/wallpaper
func (h *AvatarHandler) DeleteUserWallpaper(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	h.deleteOldFile(user.WallpaperURL)

	if err := h.userRepo.UpdateWallpaper(r.Context(), user.ID, nil); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UploadServerIcon uploads the server icon. Requires admin permission.
// Deletes the old icon file from disk if present.
// POST /api/servers/{serverId}/icon (multipart/form-data)
func (h *AvatarHandler) UploadServerIcon(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	fileURL, err := h.processUpload(r)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	currentServer, err := h.serverService.GetServer(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(currentServer.IconURL)

	server, err := h.serverService.UpdateIcon(r.Context(), serverID, fileURL)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, server)
}

// processUpload parses the multipart form, validates the file, and saves it to disk.
// Returns the URL path (e.g. "/api/uploads/a1b2c3d4_avatar.png").
func (h *AvatarHandler) processUpload(r *http.Request) (string, error) {
	if err := r.ParseMultipartForm(avatarMaxSize); err != nil {
		return "", fmt.Errorf("%w: failed to parse multipart form", pkg.ErrBadRequest)
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return "", fmt.Errorf("%w: file field is required", pkg.ErrBadRequest)
	}
	defer file.Close()

	if header.Size > avatarMaxSize {
		return "", fmt.Errorf("%w: file too large (max 8MB)", pkg.ErrBadRequest)
	}

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)

	if !allowedImageMimes[mimeBase] {
		return "", fmt.Errorf("%w: only image files are allowed (jpeg, png, gif, webp)", pkg.ErrBadRequest)
	}

	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := sanitizeAvatarFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

	destPath := filepath.Join(h.uploadDir, diskFilename)
	destFile, err := os.Create(destPath)
	if err != nil {
		return "", fmt.Errorf("failed to create file: %w", err)
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, file); err != nil {
		os.Remove(destPath)
		return "", fmt.Errorf("failed to save file: %w", err)
	}

	return "/api/uploads/" + diskFilename, nil
}

// deleteOldFile removes a previous avatar/icon file from disk.
// Silently ignores missing files -- not critical.
func (h *AvatarHandler) deleteOldFile(fileURL *string) {
	if fileURL == nil || *fileURL == "" {
		return
	}

	filename := filepath.Base(*fileURL)
	if filename == "." || filename == "/" {
		return
	}

	oldPath := filepath.Join(h.uploadDir, filename)
	os.Remove(oldPath)
}

// sanitizeAvatarFilename strips path traversal characters.
// Same logic as upload_service.go's sanitizeFilename (package-private, defined separately).
func sanitizeAvatarFilename(name string) string {
	name = filepath.Base(name)

	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '\x00' {
			return -1
		}
		return r
	}, name)

	if name == "" || name == "." || name == ".." {
		name = "unnamed"
	}

	return name
}
