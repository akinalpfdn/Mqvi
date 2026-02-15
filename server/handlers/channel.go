package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ChannelHandler, kanal endpoint'lerini yöneten struct.
type ChannelHandler struct {
	channelService services.ChannelService
}

// NewChannelHandler, constructor.
func NewChannelHandler(channelService services.ChannelService) *ChannelHandler {
	return &ChannelHandler{channelService: channelService}
}

// List godoc
// GET /api/channels
// Tüm kanalları kategorilere göre gruplar ve döner.
func (h *ChannelHandler) List(w http.ResponseWriter, r *http.Request) {
	grouped, err := h.channelService.GetAllGrouped(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, grouped)
}

// Create godoc
// POST /api/channels
// Yeni kanal oluşturur. MANAGE_CHANNELS yetkisi gerektirir.
func (h *ChannelHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req models.CreateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	channel, err := h.channelService.Create(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, channel)
}

// Update godoc
// PATCH /api/channels/{id}
// Kanalı günceller. MANAGE_CHANNELS yetkisi gerektirir.
//
// r.PathValue("id") — Go 1.22+ ile gelen path parameter desteği.
// Route tanımında {id} olarak yazılan parametreyi çeker.
// Eski yöntem: gorilla/mux veya chi router gerekiyordu.
// Go 1.22'den itibaren standart kütüphane bunu destekliyor.
func (h *ChannelHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var req models.UpdateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	channel, err := h.channelService.Update(r.Context(), id, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}

// Delete godoc
// DELETE /api/channels/{id}
// Kanalı siler. MANAGE_CHANNELS yetkisi gerektirir.
func (h *ChannelHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	if err := h.channelService.Delete(r.Context(), id); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "channel deleted"})
}

// Reorder godoc
// PATCH /api/channels/reorder
// Kanal sıralamasını toplu olarak günceller. MANAGE_CHANNELS yetkisi gerektirir.
//
// Body: { "items": [{ "id": "abc", "position": 0 }, { "id": "def", "position": 1 }] }
// Transaction ile atomik — ya hepsi güncellenir ya hiçbiri.
// Başarılıysa güncel CategoryWithChannels listesini döner ve WS broadcast eder.
func (h *ChannelHandler) Reorder(w http.ResponseWriter, r *http.Request) {
	var req models.ReorderChannelsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	grouped, err := h.channelService.ReorderChannels(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, grouped)
}
