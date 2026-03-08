// Package handlers — LinkPreviewHandler, URL Open Graph metadata endpoint'i.
//
// Route:
//   GET /api/link-preview?url=https://example.com
//
// Auth gerektirir — rate limit için kullanıcı tanımlanmalı.
// URL query param olarak alınır, server-side fetch ile metadata çekilir.
// SSRF koruması service katmanındadır.
package handlers

import (
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// LinkPreviewHandler, link preview endpoint'ini yönetir.
type LinkPreviewHandler struct {
	service services.LinkPreviewService
}

// NewLinkPreviewHandler, constructor.
func NewLinkPreviewHandler(service services.LinkPreviewService) *LinkPreviewHandler {
	return &LinkPreviewHandler{service: service}
}

// Get, URL'in Open Graph metadata'sını döner.
//
// GET /api/link-preview?url=https://example.com
//
// Response: LinkPreview JSON (title, description, image_url, site_name, favicon_url)
// Hata durumları:
//   - 400: url parametresi eksik
//   - 401: auth gerekli
//   - 502: fetch başarısız (SSRF, timeout, HTML parse hatası)
func (h *LinkPreviewHandler) Get(w http.ResponseWriter, r *http.Request) {
	_, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "url parameter is required")
		return
	}

	preview, err := h.service.GetPreview(r.Context(), rawURL)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadGateway, "failed to fetch link preview")
		return
	}

	pkg.JSON(w, http.StatusOK, preview)
}
