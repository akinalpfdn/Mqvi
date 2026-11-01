package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// SearchResult wraps search results with a total count for pagination.
type SearchResult struct {
	Messages   []models.Message `json:"messages"`
	TotalCount int              `json:"total_count"`
}

// SearchRepository defines data access for FTS5 full-text message search.
// Results are limited to channelIDs, which must belong to serverID; an empty list matches nothing.
type SearchRepository interface {
	Search(ctx context.Context, query string, serverID string, channelIDs []string, limit, offset int) (*SearchResult, error)
}
