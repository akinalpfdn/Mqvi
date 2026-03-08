// Package handlers -- GifHandler: backend proxy for Klipy GIF API.
// API key is kept server-side. Returns 503 if KLIPY_API_KEY is not set.
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

const klipyBaseURL = "https://api.klipy.com"

// GifResult is the simplified GIF info returned to the client.
type GifResult struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	PreviewURL string `json:"preview_url"` // xs gif for picker thumbnail
	URL        string `json:"url"`         // md gif for message display
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

type GifHandler struct {
	klipyAPIKey string
}

func NewGifHandler(klipyAPIKey string) *GifHandler {
	return &GifHandler{klipyAPIKey: klipyAPIKey}
}

// Trending returns popular GIFs.
// GET /api/gifs/trending?per_page=24&page=1
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

// Search returns GIF search results.
// GET /api/gifs/search?q=funny&per_page=24&page=1
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

// ── Klipy API response types ──

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

// klipyFiles maps size tiers (hd, md, sm, xs) to format URLs.
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
		// Prefer md (medium) for message display, fallback to sm then hd
		gifURL := pickMediaURL(item.File.MD.GIF, item.File.SM.GIF, item.File.HD.GIF)
		if gifURL == "" {
			continue
		}

		// Prefer xs (extra small) for picker thumbnail
		previewURL := pickMediaURL(item.File.XS.GIF, item.File.SM.GIF, nil)
		if previewURL == "" {
			previewURL = gifURL
		}

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

// pickMediaURL returns the first non-nil media URL from the given options.
func pickMediaURL(options ...*klipyMedia) string {
	for _, m := range options {
		if m != nil && m.URL != "" {
			return m.URL
		}
	}
	return ""
}

// clampInt parses a string to int and clamps it within [min, max].
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
