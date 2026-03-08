// Package models — LinkPreview, Open Graph metadata cache kaydı.
//
// URL bazlı deduplicated cache — aynı URL birden fazla kullanıcı
// tarafından paylaşıldığında tekrar fetch yapılmaz.
// Error flag'li kayıtlar başarısız fetch'leri temsil eder.
package models

// LinkPreview, bir URL'in Open Graph metadata bilgilerini tutar.
type LinkPreview struct {
	URL         string  `json:"url"`
	Title       *string `json:"title"`
	Description *string `json:"description"`
	ImageURL    *string `json:"image_url"`
	SiteName    *string `json:"site_name"`
	FaviconURL  *string `json:"favicon_url"`
	FetchedAt   string  `json:"fetched_at"`
	Error       bool    `json:"-"` // client'a açılmaz
}
