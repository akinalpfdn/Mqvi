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
// channelID: Opsiyonel — belirli bir kanalla sınırla (nil = tüm kanallar).
// limit, offset: Pagination parametreleri.
type SearchRepository interface {
	Search(ctx context.Context, query string, channelID *string, limit, offset int) (*SearchResult, error)
}
