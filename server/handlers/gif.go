// Package handlers — GIF arama endpoint'leri.
//
// GifHandler, Klipy API için backend proxy görevi görür.
// API key server-side'da tutulur, client'a açılmaz.
//
// Route'lar:
//   GET /api/gifs/trending  — Popüler GIF'ler
//   GET /api/gifs/search    — GIF arama (q parametresi)
//
// Klipy API docs: https://docs.klipy.com/
// Klipy, Tenor'un halefidir — Discord/WhatsApp dahil geçiş yapıldı.
// KLIPY_API_KEY yoksa her iki endpoint 503 döner.
package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// klipyBaseURL, Klipy API production base URL'i.
const klipyBaseURL = "https://api.klipy.com"

// GifResult, client'a dönen simplified GIF bilgisi.
// Klipy'nin büyük response objesi yerine sadece gerekli alanlar taşınır.
type GifResult struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	PreviewURL string `json:"preview_url"` // xs gif — picker thumbnail (küçük, hızlı)
	URL        string `json:"url"`         // md gif — mesajda gönderilecek orta boyut
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

// GifHandler, Klipy API proxy endpoint'lerini yöneten handler.
type GifHandler struct {
	klipyAPIKey string
}

// NewGifHandler, constructor.
// klipyAPIKey boşsa endpoint'ler 503 döner (opsiyonel özellik — email pattern).
func NewGifHandler(klipyAPIKey string) *GifHandler {
	return &GifHandler{klipyAPIKey: klipyAPIKey}
}

// Trending, popüler GIF'leri döner.
//
// GET /api/gifs/trending?per_page=24&page=1
// Query params:
//   - per_page: sonuç sayısı (default 24, max 50)
//   - page: sayfa numarası (default 1)
func (h *GifHandler) Trending(w http.ResponseWriter, r *http.Request) {
	if h.klipyAPIKey == "" {
		pkg.ErrorWithMessage(w, http.StatusServiceUnavailable, "GIF service not configured")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	perPage := clampInt(r.URL.Query().Get("per_page"), 24, 1, 50)
	page := clampInt(r.URL.Query().Get("page"), 1, 1, 100)

	url := fmt.Sprintf("%s/api/v1/%s/gifs/trending?per_page=%d&page=%d&customer_id=%s",
		klipyBaseURL, h.klipyAPIKey, perPage, page, user.ID)

	results, hasNext, err := fetchKlipyResults(url)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadGateway, "failed to fetch trending GIFs")
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"results":  results,
		"has_next": hasNext,
	})
}

// Search, GIF arama sonuçlarını döner.
//
// GET /api/gifs/search?q=funny&per_page=24&page=1
// Query params:
//   - q: arama sorgusu (zorunlu)
//   - per_page: sonuç sayısı (default 24, max 50)
//   - page: sayfa numarası (default 1)
func (h *GifHandler) Search(w http.ResponseWriter, r *http.Request) {
	if h.klipyAPIKey == "" {
		pkg.ErrorWithMessage(w, http.StatusServiceUnavailable, "GIF service not configured")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "search query (q) is required")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	perPage := clampInt(r.URL.Query().Get("per_page"), 24, 8, 50)
	page := clampInt(r.URL.Query().Get("page"), 1, 1, 100)

	url := fmt.Sprintf("%s/api/v1/%s/gifs/search?q=%s&per_page=%d&page=%d&customer_id=%s",
		klipyBaseURL, h.klipyAPIKey, query, perPage, page, user.ID)

	results, hasNext, err := fetchKlipyResults(url)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadGateway, "failed to search GIFs")
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"results":  results,
		"has_next": hasNext,
	})
}

// ─── Klipy API response types ───

// klipyAPIResponse, Klipy API'nin ham response yapısı.
type klipyAPIResponse struct {
	Result bool          `json:"result"`
	Data   klipyDataWrap `json:"data"`
}

type klipyDataWrap struct {
	Data    []klipyItem `json:"data"`
	HasNext bool        `json:"has_next"`
}

type klipyItem struct {
	ID    int        `json:"id"`
	Slug  string     `json:"slug"`
	Title string     `json:"title"`
	File  klipyFiles `json:"file"`
}

// klipyFiles, her boyut tier'ı için format → URL mapping.
// Tier'lar: hd (full), md (medium), sm (small), xs (extra small).
type klipyFiles struct {
	HD klipyFormats `json:"hd"`
	MD klipyFormats `json:"md"`
	SM klipyFormats `json:"sm"`
	XS klipyFormats `json:"xs"`
}

type klipyFormats struct {
	GIF  *klipyMedia `json:"gif"`
	WebP *klipyMedia `json:"webp"`
	MP4  *klipyMedia `json:"mp4"`
}

type klipyMedia struct {
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Size   int    `json:"size"`
}

// fetchKlipyResults, Klipy API'ye HTTP isteği atar ve GifResult slice'ına dönüştürür.
func fetchKlipyResults(url string) ([]GifResult, bool, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, false, fmt.Errorf("klipy request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, false, fmt.Errorf("klipy returned %d: %s", resp.StatusCode, string(body))
	}

	var klipyResp klipyAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&klipyResp); err != nil {
		return nil, false, fmt.Errorf("klipy response decode failed: %w", err)
	}

	if !klipyResp.Result {
		return nil, false, fmt.Errorf("klipy returned result=false")
	}

	results := make([]GifResult, 0, len(klipyResp.Data.Data))
	for _, item := range klipyResp.Data.Data {
		// Mesajda gösterilecek GIF URL — md (medium) tercih, yoksa sm, yoksa hd
		gifURL := pickMediaURL(item.File.MD.GIF, item.File.SM.GIF, item.File.HD.GIF)
		if gifURL == "" {
			continue // GIF format yoksa bu sonucu atla
		}

		// Picker thumbnail — xs (extra small) tercih, yoksa sm
		previewURL := pickMediaURL(item.File.XS.GIF, item.File.SM.GIF, nil)
		if previewURL == "" {
			previewURL = gifURL // fallback: ana GIF
		}

		// Boyutlar — md tier'dan al
		var width, height int
		if item.File.MD.GIF != nil {
			width = item.File.MD.GIF.Width
			height = item.File.MD.GIF.Height
		}

		results = append(results, GifResult{
			ID:         fmt.Sprintf("%d", item.ID),
			Title:      item.Title,
			PreviewURL: previewURL,
			URL:        gifURL,
			Width:      width,
			Height:     height,
		})
	}

	return results, klipyResp.Data.HasNext, nil
}

// pickMediaURL, verilen media pointer'larından ilk mevcut URL'i döner.
func pickMediaURL(options ...*klipyMedia) string {
	for _, m := range options {
		if m != nil && m.URL != "" {
			return m.URL
		}
	}
	return ""
}

// clampInt, string değeri int'e çevirir ve min/max aralığına sınırlar.
// Parse hatası veya boş string durumunda defaultVal döner.
func clampInt(s string, defaultVal, min, max int) int {
	if s == "" {
		return defaultVal
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return defaultVal
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}
