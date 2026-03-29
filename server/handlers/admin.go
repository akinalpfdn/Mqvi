// Package handlers -- AdminHandler: platform admin endpoints.
// Protected by PlatformAdminMiddleware.
package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ScreenShareStatsProvider exposes screen share metrics for the admin panel.
// Implemented by VoiceService — minimal ISP to avoid importing full voice layer.
type ScreenShareStatsProvider interface {
	GetScreenShareStats() (streamers int, viewers int)
}

type AdminHandler struct {
	livekitAdminService   services.LiveKitAdminService
	metricsHistoryService services.MetricsHistoryService
	adminUserService      services.AdminUserService
	adminServerService    services.AdminServerService
	reportService         services.ReportService
	appLogService         services.AppLogService
	screenShareStats      ScreenShareStatsProvider
}

func NewAdminHandler(
	livekitAdminService services.LiveKitAdminService,
	metricsHistoryService services.MetricsHistoryService,
	adminUserService services.AdminUserService,
	adminServerService services.AdminServerService,
	reportService services.ReportService,
	appLogService services.AppLogService,
	screenShareStats ScreenShareStatsProvider,
) *AdminHandler {
	return &AdminHandler{
		livekitAdminService:   livekitAdminService,
		metricsHistoryService: metricsHistoryService,
		adminUserService:      adminUserService,
		adminServerService:    adminServerService,
		reportService:         reportService,
		appLogService:         appLogService,
		screenShareStats:      screenShareStats,
	}
}

// ListAppLogs -- GET /api/admin/logs
func (h *AdminHandler) ListAppLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))

	filter := models.AppLogFilter{
		Level:    q.Get("level"),
		Category: q.Get("category"),
		Search:   q.Get("search"),
		Limit:    limit,
		Offset:   offset,
	}

	logs, total, err := h.appLogService.List(r.Context(), filter)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]interface{}{
		"logs":  logs,
		"total": total,
	})
}

// ClearAppLogs -- DELETE /api/admin/logs
func (h *AdminHandler) ClearAppLogs(w http.ResponseWriter, r *http.Request) {
	if err := h.appLogService.Clear(r.Context()); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ListLiveKitInstances -- GET /api/admin/livekit-instances
func (h *AdminHandler) ListLiveKitInstances(w http.ResponseWriter, r *http.Request) {
	instances, err := h.livekitAdminService.ListInstances(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, instances)
}

// GetLiveKitInstance -- GET /api/admin/livekit-instances/{id}
func (h *AdminHandler) GetLiveKitInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	instance, err := h.livekitAdminService.GetInstance(r.Context(), id)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, instance)
}

// CreateLiveKitInstance -- POST /api/admin/livekit-instances
func (h *AdminHandler) CreateLiveKitInstance(w http.ResponseWriter, r *http.Request) {
	var req models.CreateLiveKitInstanceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	instance, err := h.livekitAdminService.CreateInstance(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, instance)
}

// UpdateLiveKitInstance -- PATCH /api/admin/livekit-instances/{id}
func (h *AdminHandler) UpdateLiveKitInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	var req models.UpdateLiveKitInstanceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	instance, err := h.livekitAdminService.UpdateInstance(r.Context(), id, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, instance)
}

// DeleteLiveKitInstance -- DELETE /api/admin/livekit-instances/{id}?migrate_to={targetId}
// If servers are attached, migrate_to must specify the target instance.
func (h *AdminHandler) DeleteLiveKitInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	migrateToID := r.URL.Query().Get("migrate_to")

	if err := h.livekitAdminService.DeleteInstance(r.Context(), id, migrateToID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "instance deleted"})
}

// ListServers -- GET /api/admin/servers
func (h *AdminHandler) ListServers(w http.ResponseWriter, r *http.Request) {
	servers, err := h.livekitAdminService.ListServers(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, servers)
}

// MigrateServerInstance -- PATCH /api/admin/servers/{serverId}/instance
func (h *AdminHandler) MigrateServerInstance(w http.ResponseWriter, r *http.Request) {
	serverID := r.PathValue("serverId")
	if serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server id is required")
		return
	}

	var req models.MigrateServerInstanceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.livekitAdminService.MigrateServerInstance(r.Context(), serverID, req.LiveKitInstanceID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "server instance updated"})
}

// GetLiveKitInstanceMetrics -- GET /api/admin/livekit-instances/{id}/metrics
// Fetches live metrics from the instance's Prometheus endpoint.
func (h *AdminHandler) GetLiveKitInstanceMetrics(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	metrics, err := h.livekitAdminService.GetInstanceMetrics(r.Context(), id)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if h.screenShareStats != nil {
		streamers, viewers := h.screenShareStats.GetScreenShareStats()
		metrics.ScreenShareCount = streamers
		metrics.ScreenShareViewers = viewers
	}

	pkg.JSON(w, http.StatusOK, metrics)
}

// ListUsers -- GET /api/admin/users
func (h *AdminHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.livekitAdminService.ListUsers(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, users)
}

// GetLiveKitInstanceMetricsHistory -- GET /api/admin/livekit-instances/{id}/metrics/history?period=24h
// period: "24h" (default), "7d", "30d"
func (h *AdminHandler) GetLiveKitInstanceMetricsHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	period := r.URL.Query().Get("period")
	if period == "" {
		period = "24h"
	}

	summary, err := h.metricsHistoryService.GetSummary(r.Context(), id, period)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, summary)
}

// GetLiveKitInstanceMetricsTimeSeries -- GET /api/admin/livekit-instances/{id}/metrics/timeseries?period=24h
// Returns raw time-series data for charts. period: "24h" (default), "7d", "30d"
func (h *AdminHandler) GetLiveKitInstanceMetricsTimeSeries(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	period := r.URL.Query().Get("period")
	if period == "" {
		period = "24h"
	}

	points, err := h.metricsHistoryService.GetTimeSeries(r.Context(), id, period)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, points)
}

// PlatformBanUser -- POST /api/admin/users/{id}/ban
// Body: { "reason": "...", "delete_messages": true/false }
func (h *AdminHandler) PlatformBanUser(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	targetID := r.PathValue("id")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user id is required")
		return
	}

	var req models.PlatformBanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.adminUserService.PlatformBanUser(r.Context(), admin.ID, targetID, req.Reason, req.DeleteMessages); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "user banned"})
}

// PlatformUnbanUser -- DELETE /api/admin/users/{id}/ban
func (h *AdminHandler) PlatformUnbanUser(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	targetID := r.PathValue("id")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user id is required")
		return
	}

	if err := h.adminUserService.PlatformUnbanUser(r.Context(), admin.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "user unbanned"})
}

// HardDeleteUser -- DELETE /api/admin/users/{id}
// Optional body: { "reason": "..." }
func (h *AdminHandler) HardDeleteUser(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	targetID := r.PathValue("id")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user id is required")
		return
	}

	// Optional reason body -- DELETE body may be empty
	var req models.HardDeleteUserRequest
	_ = json.NewDecoder(r.Body).Decode(&req)

	if err := h.adminUserService.HardDeleteUser(r.Context(), admin.ID, targetID, req.Reason); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "user deleted"})
}

// SetUserPlatformAdmin -- PATCH /api/admin/users/{id}/platform-admin
// Body: { "is_admin": true/false }
func (h *AdminHandler) SetUserPlatformAdmin(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	targetID := r.PathValue("id")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user id is required")
		return
	}

	var req models.SetPlatformAdminRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.adminUserService.SetPlatformAdmin(r.Context(), admin.ID, targetID, req.IsAdmin); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "admin status updated"})
}

// AdminDeleteServer -- DELETE /api/admin/servers/{serverId}
// Optional body: { "reason": "..." }
func (h *AdminHandler) AdminDeleteServer(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	serverID := r.PathValue("serverId")
	if serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server id is required")
		return
	}

	// Optional reason body -- DELETE body may be empty
	var req models.AdminDeleteServerRequest
	_ = json.NewDecoder(r.Body).Decode(&req)

	if err := h.adminServerService.DeleteServer(r.Context(), admin.ID, serverID, req.Reason); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "server deleted"})
}

// ── Reports ──

// ListReports -- GET /api/admin/reports?status=pending&limit=50&offset=0
func (h *AdminHandler) ListReports(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")

	limit := 100
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	reports, total, err := h.reportService.ListReports(r.Context(), status, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"reports": reports,
		"total":   total,
	})
}

// UpdateReportStatus -- PATCH /api/admin/reports/{id}/status
// Body: { "status": "reviewed" | "resolved" | "dismissed" | "pending" }
func (h *AdminHandler) UpdateReportStatus(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	reportID := r.PathValue("id")
	if reportID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "report id is required")
		return
	}

	var req models.UpdateReportStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.reportService.UpdateReportStatus(r.Context(), reportID, models.ReportStatus(req.Status), admin.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "report status updated"})
}
