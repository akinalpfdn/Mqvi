// Package handlers — ServerHandler: sunucu ayarları HTTP endpoint'leri.
//
// Thin handler prensibi: Parse → Service → Response.
// Sunucu bilgisi okuma herkese açık (authenticated),
// güncelleme ise Admin yetkisi gerektirir (permMiddleware ile korunur).
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ServerHandler, sunucu ayarları endpoint'lerini yönetir.
type ServerHandler struct {
	serverService services.ServerService
}

// NewServerHandler, constructor.
func NewServerHandler(serverService services.ServerService) *ServerHandler {
	return &ServerHandler{serverService: serverService}
}

// Get godoc
// GET /api/server
// Sunucu bilgisini döner (isim, ikon).
// Tüm authenticated kullanıcılar erişebilir.
func (h *ServerHandler) Get(w http.ResponseWriter, r *http.Request) {
	server, err := h.serverService.Get(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, server)
}

// Update godoc
// PATCH /api/server
// Body: { "name": "Yeni Sunucu Adı" }
//
// Sunucu bilgisini günceller. Admin yetkisi gerektirir.
// permMiddleware ile korunur — handler'a ulaşan request yetkili demektir.
func (h *ServerHandler) Update(w http.ResponseWriter, r *http.Request) {
	var req models.UpdateServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	server, err := h.serverService.Update(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, server)
}
