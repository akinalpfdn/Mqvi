package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// SearchResult, arama sonucunu temsil eder.
// Mesaj bilgisine ek olarak toplam sonuç sayısını da taşır (pagination için).
type SearchResult struct {
	Messages   []models.Message `json:"messages"`
	TotalCount int              `json:"total_count"`
}

// SearchRepository, tam metin arama veritabanı işlemleri için interface.
//
// Search: FTS5 ile mesaj araması yapar.
// query: Arama terimi — FTS5 match syntax'ı destekler.
// serverID: Zorunlu — aramayı sunucunun kanallarıyla sınırlar.
// channelID: Opsiyonel — belirli bir kanalla sınırla (nil = sunucunun tüm kanalları).
// limit, offset: Pagination parametreleri.
type SearchRepository interface {
	Search(ctx context.Context, query string, serverID string, channelID *string, limit, offset int) (*SearchResult, error)
}
