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
// serverID is required. channelID is optional (nil searches all server channels).
type SearchRepository interface {
	Search(ctx context.Context, query string, serverID string, channelID *string, limit, offset int) (*SearchResult, error)
}
