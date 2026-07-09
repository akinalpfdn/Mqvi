package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

const (
	discoveryDefaultLimit = 24
	discoveryMaxLimit     = 48
)

// DiscoveryHandler serves the public server directory (browse/search), joining, and reporting.
type DiscoveryHandler struct {
	discoveryService services.DiscoveryService
	serverService    services.ServerService
	reportService    services.ReportService
	limiter          *ratelimit.MessageRateLimiter
}

func NewDiscoveryHandler(discoveryService services.DiscoveryService, serverService services.ServerService, reportService services.ReportService, limiter *ratelimit.MessageRateLimiter) *DiscoveryHandler {
	return &DiscoveryHandler{discoveryService: discoveryService, serverService: serverService, reportService: reportService, limiter: limiter}
}

// rateLimited writes a 429 (with Retry-After) and returns true when the user is over budget.
func (h *DiscoveryHandler) rateLimited(w http.ResponseWriter, userID string) bool {
	if h.limiter != nil && !h.limiter.Allow(userID) {
		w.Header().Set("Retry-After", fmt.Sprintf("%d", h.limiter.CooldownSeconds(userID)))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many requests, slow down")
		return true
	}
	return false
}

// ListPublicServers -- GET /api/discovery/servers?q=&category=&featured=&page=&limit=
func (h *DiscoveryHandler) ListPublicServers(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if h.rateLimited(w, user.ID) {
		return
	}

	q := r.URL.Query()
	limit := parseDiscoveryInt(q.Get("limit"), discoveryDefaultLimit, discoveryMaxLimit)
	page := parseDiscoveryInt(q.Get("page"), 1, 1<<20)

	category := strings.TrimSpace(q.Get("category"))
	if category != "" && !models.ValidServerCategories[category] {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid category")
		return
	}

	params := models.PublicServerListParams{
		RequestingUserID: user.ID,
		Category:         category,
		Search:           q.Get("q"),
		FeaturedOnly:     q.Get("featured") == "true",
		Limit:            limit,
		Offset:           (page - 1) * limit,
	}

	res, err := h.discoveryService.ListPublicServers(r.Context(), params)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, res)
}

// GetPublicServer -- GET /api/discovery/servers/{id}
func (h *DiscoveryHandler) GetPublicServer(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	serverID := r.PathValue("id")
	if serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server id is required")
		return
	}
	item, err := h.discoveryService.GetPublicServer(r.Context(), serverID, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, item)
}

// JoinPublicServer -- POST /api/discovery/servers/{id}/join
func (h *DiscoveryHandler) JoinPublicServer(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if h.rateLimited(w, user.ID) {
		return
	}
	serverID := r.PathValue("id")
	if serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server id is required")
		return
	}

	result, err := h.serverService.JoinPublicServer(r.Context(), user.ID, serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Pending → an approval request was created; no membership yet.
	if result.Pending {
		pkg.JSON(w, http.StatusOK, map[string]any{"pending": true})
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"pending": false, "server": result.Server})
}

// ReportServer -- POST /api/discovery/servers/{id}/report
func (h *DiscoveryHandler) ReportServer(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if h.rateLimited(w, user.ID) {
		return
	}
	serverID := r.PathValue("id")
	if serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server id is required")
		return
	}

	var req models.CreateReportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if _, err := h.reportService.CreateServerReport(r.Context(), user.ID, serverID, &req); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"message": "report submitted"})
}

// parseDiscoveryInt returns a clamped positive int from a query value, or def if absent/invalid.
func parseDiscoveryInt(s string, def, max int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}
