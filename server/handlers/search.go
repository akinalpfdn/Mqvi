package handlers

import (
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// SearchHandler, mesaj arama endpoint'ini yöneten struct.
type SearchHandler struct {
	searchService services.SearchService
}

// NewSearchHandler, constructor.
func NewSearchHandler(searchService services.SearchService) *SearchHandler {
	return &SearchHandler{searchService: searchService}
}

// Search godoc
// GET /api/servers/{serverId}/search?q=query&channel_id=optional&limit=25&offset=0
// FTS5 ile tam metin araması yapar. Sunucu bazlı — sadece bu sunucunun kanallarında arar.
func (h *SearchHandler) Search(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "query parameter 'q' is required")
		return
	}

	// Opsiyonel kanal filtresi
	var channelID *string
	if cid := r.URL.Query().Get("channel_id"); cid != "" {
		channelID = &cid
	}

	// Limit
	limit := 25
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	// Offset
	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	result, err := h.searchService.Search(r.Context(), serverID, query, channelID, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, result)
}
