package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// SearchService, mesaj arama iş mantığı interface'i.
// Arama sunucu bazlıdır — sadece sunucunun kanallarındaki mesajlar aranır.
type SearchService interface {
	Search(ctx context.Context, serverID, query string, channelID *string, limit, offset int) (*repository.SearchResult, error)
}

type searchService struct {
	searchRepo repository.SearchRepository
}

func NewSearchService(searchRepo repository.SearchRepository) SearchService {
	return &searchService{searchRepo: searchRepo}
}

func (s *searchService) Search(ctx context.Context, serverID, query string, channelID *string, limit, offset int) (*repository.SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("%w: search query is required", pkg.ErrBadRequest)
	}
	if len(query) > 100 {
		return nil, fmt.Errorf("%w: search query must be at most 100 characters", pkg.ErrBadRequest)
	}

	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	return s.searchRepo.Search(ctx, query, serverID, channelID, limit, offset)
}
