package handlers

import (
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// SearchHandler, mesaj arama endpoint'ini yöneten struct.
//
// Thin handler: query parameter parse + response yazımı.
// Tüm iş mantığı SearchService'de.
type SearchHandler struct {
	searchService services.SearchService
}

// NewSearchHandler, constructor.
func NewSearchHandler(searchService services.SearchService) *SearchHandler {
	return &SearchHandler{searchService: searchService}
}

// Search godoc
// GET /api/search?q=query&channel_id=optional&limit=25&offset=0
// FTS5 ile tam metin araması yapar.
//
// Query parametreleri:
// - q (zorunlu): Arama terimi
// - channel_id (opsiyonel): Belirli bir kanalla sınırla
// - limit (opsiyonel): Sonuç sayısı (default 25, max 100)
// - offset (opsiyonel): Pagination offset (default 0)
func (h *SearchHandler) Search(w http.ResponseWriter, r *http.Request) {
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

	result, err := h.searchService.Search(r.Context(), query, channelID, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, result)
}
