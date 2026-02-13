package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// SearchService, mesaj arama iş mantığı interface'i.
//
// Search: FTS5 ile tam metin araması yapar.
// query: Minimum 1 karakter, maksimum 100 karakter.
// channelID: Opsiyonel kanal filtresi.
// limit, offset: Pagination.
type SearchService interface {
	Search(ctx context.Context, query string, channelID *string, limit, offset int) (*repository.SearchResult, error)
}

type searchService struct {
	searchRepo repository.SearchRepository
}

// NewSearchService, constructor.
func NewSearchService(searchRepo repository.SearchRepository) SearchService {
	return &searchService{searchRepo: searchRepo}
}

// Search, mesaj arama yapar.
//
// Validasyon:
// 1. Query boş olamaz (trim sonrası)
// 2. Query 100 karakterden uzun olamaz
// 3. Limit ve offset normalize edilir
func (s *searchService) Search(ctx context.Context, query string, channelID *string, limit, offset int) (*repository.SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("%w: search query is required", pkg.ErrBadRequest)
	}
	if len(query) > 100 {
		return nil, fmt.Errorf("%w: search query must be at most 100 characters", pkg.ErrBadRequest)
	}

	// Limit koruma
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	return s.searchRepo.Search(ctx, query, channelID, limit, offset)
}
