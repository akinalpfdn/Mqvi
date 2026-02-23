// Package handlers, HTTP request handler'larını içerir.
//
// StatsHandler, public (auth gerektirmeyen) istatistik endpoint'lerini yönetir.
// Şu an sadece toplam kayıtlı kullanıcı sayısını döner.
// Landing page'de gösterilmek üzere tasarlandı.
package handlers

import (
	"net/http"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// StatsResponse, public istatistik endpoint'inin response formatı.
type StatsResponse struct {
	TotalUsers int `json:"total_users"`
}

// StatsHandler, istatistik endpoint'lerini yöneten handler.
// Dependency olarak sadece UserRepository alır — Count() metodu zaten mevcut.
type StatsHandler struct {
	userRepo repository.UserRepository
}

// NewStatsHandler, constructor. main.go'da wire-up edilir.
func NewStatsHandler(userRepo repository.UserRepository) *StatsHandler {
	return &StatsHandler{userRepo: userRepo}
}

// GetPublicStats, toplam kayıtlı kullanıcı sayısını döner.
// Auth gerekmez — landing page'den çağrılır.
//
// GET /api/stats
// Response: { "success": true, "data": { "total_users": 42 } }
func (h *StatsHandler) GetPublicStats(w http.ResponseWriter, r *http.Request) {
	count, err := h.userRepo.Count(r.Context())
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to get stats")
		return
	}

	pkg.JSON(w, http.StatusOK, StatsResponse{TotalUsers: count})
}
