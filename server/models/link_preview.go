// Package models — LinkPreview, deduplicated Open Graph metadata cache.
package models

// LinkPreview holds Open Graph metadata for a URL.
type LinkPreview struct {
	URL         string  `json:"url"`
	Title       *string `json:"title"`
	Description *string `json:"description"`
	ImageURL    *string `json:"image_url"`
	SiteName    *string `json:"site_name"`
	FaviconURL  *string `json:"favicon_url"`
	FetchedAt   string  `json:"fetched_at"`
	Error       bool    `json:"-"` // not exposed to client
}
