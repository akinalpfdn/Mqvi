// Package handlers -- AdminHandler: platform admin endpoints.
// Protected by PlatformAdminMiddleware.
package handlers

import (
	"encoding/json"
	"io"
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
	badgeService          services.SettingsBadgeService
	screenShareStats      ScreenShareStatsProvider
}

func NewAdminHandler(
	livekitAdminService services.LiveKitAdminService,
	metricsHistoryService services.MetricsHistoryService,
	adminUserService services.AdminUserService,
	adminServerService services.AdminServerService,
	reportService services.ReportService,
	appLogService services.AppLogService,
	badgeService services.SettingsBadgeService,
	screenShareStats ScreenShareStatsProvider,
) *AdminHandler {
	return &AdminHandler{
		livekitAdminService:   livekitAdminService,
		metricsHistoryService: metricsHistoryService,
		adminUserService:      adminUserService,
		adminServerService:    adminServerService,
		reportService:         reportService,
		appLogService:         appLogService,
		badgeService:          badgeService,
		screenShareStats:      screenShareStats,
	}
}

// GetBadges -- GET /api/admin/badges
// Returns whether the current admin has unseen feedback or reports.
func (h *AdminHandler) GetBadges(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	state, err := h.badgeService.GetAdminBadges(r.Context(), admin)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, state)
}

// MarkFeedbackSeen -- POST /api/admin/feedback/mark-seen
func (h *AdminHandler) MarkFeedbackSeen(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.badgeService.MarkFeedbackSeen(r.Context(), admin.ID); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MarkReportsSeen -- POST /api/admin/reports/mark-seen
func (h *AdminHandler) MarkReportsSeen(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.badgeService.MarkReportsSeen(r.Context(), admin.ID); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
// Query: ?limit=50&offset=0&search=foo&status=active&status=soft_deleted&type=managed&sort=name&dir=asc
// status/type are repeatable (empty = all).
func (h *AdminHandler) ListServers(w http.ResponseWriter, r *http.Request) {
	page, err := h.livekitAdminService.ListServersPaged(r.Context(),
		parseAdminListParams(r, []string{"active", "soft_deleted"}))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, page)
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

// SetServerDiscoveryFlag -- PATCH /api/admin/servers/{serverId}/discovery-flag
// Body: { "flag": "verified"|"featured"|"discovery_blocked", "value": true }
func (h *AdminHandler) SetServerDiscoveryFlag(w http.ResponseWriter, r *http.Request) {
	serverID := r.PathValue("serverId")
	if serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server id is required")
		return
	}

	var req struct {
		Flag  string `json:"flag"`
		Value bool   `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	server, err := h.adminServerService.SetDiscoveryFlag(r.Context(), serverID, req.Flag, req.Value)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, server)
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
// Query: ?limit=50&offset=0&search=foo&status=active&status=banned&presence=online&admin=admin&sort=username&dir=asc
// status/presence/admin are repeatable (empty = all).
func (h *AdminHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	page, err := h.livekitAdminService.ListUsersPaged(r.Context(),
		parseAdminListParams(r, []string{"active", "banned", "soft_deleted", "tombstone"}))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, page)
}

// parseAdminListParams — shared limit/offset/search/status/sort/dir extractor.
// allowedStatuses is the per-endpoint whitelist; values outside it fall back to "all".
// Limit clamped to [1,100], default 50. Dir defaults to "desc".
// Sort is opaque here — repo enforces its own whitelist.
func parseAdminListParams(r *http.Request, allowedStatuses []string) models.AdminListPageParams {
	q := r.URL.Query()
	limit := 50
	if s := q.Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			if n < 1 {
				n = 1
			} else if n > 100 {
				n = 100
			}
			limit = n
		}
	}
	offset := 0
	if s := q.Get("offset"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n >= 0 {
			offset = n
		}
	}
	dir := q.Get("dir")
	if dir != "asc" && dir != "desc" {
		dir = "desc"
	}
	return models.AdminListPageParams{
		Limit:     limit,
		Offset:    offset,
		Search:    q.Get("search"),
		Statuses:  filterAllowed(parseMultiQuery(r, "status"), allowedStatuses),
		Presences: filterAllowed(parseMultiQuery(r, "presence"), []string{"online", "idle", "dnd", "offline"}),
		Admin:     filterAllowed(parseMultiQuery(r, "admin"), []string{"admin", "non_admin"}),
		Types:     filterAllowed(parseMultiQuery(r, "type"), []string{"managed", "self"}),
		Sort:      q.Get("sort"),
		Dir:       dir,
	}
}

// filterAllowed returns only the values present in the whitelist, preserving order.
// Keeps caller-supplied filter values from ever reaching SQL unvalidated.
func filterAllowed(vals, allowed []string) []string {
	if len(vals) == 0 {
		return nil
	}
	set := make(map[string]bool, len(allowed))
	for _, a := range allowed {
		set[a] = true
	}
	var out []string
	for _, v := range vals {
		if set[v] {
			out = append(out, v)
		}
	}
	return out
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
// Body: { "reason": "...", "hard_delete": false }
// hard_delete=false (default) → soft-delete (recoverable, 30-day TTL).
// hard_delete=true → tombstone (anonymize, irreversible).
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

	var req models.HardDeleteUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		// Empty body is acceptable (defaults: soft delete, no reason).
		// Malformed JSON is a hard 400 — silent fallback hid bugs before.
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.HardDelete {
		if err := h.adminUserService.HardDeleteUser(r.Context(), admin.ID, targetID, req.Reason); err != nil {
			pkg.Error(w, err)
			return
		}
		pkg.JSON(w, http.StatusOK, map[string]string{"message": "user permanently deleted"})
		return
	}

	if err := h.adminUserService.SoftDeleteUser(r.Context(), admin.ID, targetID, req.Reason); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "user soft-deleted"})
}

// AdminRestoreUser -- POST /api/admin/users/{id}/restore
// Restores a soft-deleted user (admin override). Tombstones cannot be restored.
func (h *AdminHandler) AdminRestoreUser(w http.ResponseWriter, r *http.Request) {
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

	if err := h.adminUserService.RestoreUser(r.Context(), admin.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "user restored"})
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
// Body: { "reason": "...", "hard_delete": false }
// hard_delete=false (default) → soft delete (restorable, 30-day TTL).
// hard_delete=true → permanent delete (skip TTL).
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

	var req models.AdminDeleteServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		// Empty body is acceptable (defaults: soft delete, no reason).
		// Malformed JSON is a hard 400 — silent fallback hid bugs before.
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.HardDelete {
		if err := h.adminServerService.HardDeleteServer(r.Context(), admin.ID, serverID, req.Reason); err != nil {
			pkg.Error(w, err)
			return
		}
		pkg.JSON(w, http.StatusOK, map[string]string{"message": "server permanently deleted"})
		return
	}

	if err := h.adminServerService.DeleteServer(r.Context(), admin.ID, serverID, req.Reason); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "server soft-deleted"})
}

// AdminRestoreServer -- POST /api/admin/servers/{serverId}/restore
// Restores any soft-deleted server (admin override — works regardless of deleted_by_admin).
func (h *AdminHandler) AdminRestoreServer(w http.ResponseWriter, r *http.Request) {
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

	if err := h.adminServerService.RestoreServer(r.Context(), admin.ID, serverID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "server restored"})
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

// ListServerReports -- GET /api/admin/server-reports?status=&limit=&offset=
func (h *AdminHandler) ListServerReports(w http.ResponseWriter, r *http.Request) {
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

	reports, total, err := h.reportService.ListServerReports(r.Context(), status, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{"reports": reports, "total": total})
}

// UpdateServerReportStatus -- PATCH /api/admin/server-reports/{id}/status
func (h *AdminHandler) UpdateServerReportStatus(w http.ResponseWriter, r *http.Request) {
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

	if err := h.reportService.UpdateServerReportStatus(r.Context(), reportID, models.ReportStatus(req.Status), admin.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "report status updated"})
}
