package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// SearchService handles server-scoped message search (FTS5).
type SearchService interface {
	Search(ctx context.Context, userID, serverID, query string, channelID *string, limit, offset int) (*repository.SearchResult, error)
}

// SearchChannelLister lists a server's channels so search can decide which of them the caller reads.
type SearchChannelLister interface {
	GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error)
}

type searchService struct {
	searchRepo   repository.SearchRepository
	channels     SearchChannelLister
	permResolver ChannelPermResolver
	urlSigner    FileURLSigner
}

func NewSearchService(
	searchRepo repository.SearchRepository,
	channels SearchChannelLister,
	permResolver ChannelPermResolver,
	urlSigner FileURLSigner,
) SearchService {
	return &searchService{searchRepo: searchRepo, channels: channels, permResolver: permResolver, urlSigner: urlSigner}
}

func (s *searchService) Search(ctx context.Context, userID, serverID, query string, channelID *string, limit, offset int) (*repository.SearchResult, error) {
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

	readable, err := s.readableChannelIDs(ctx, userID, serverID)
	if err != nil {
		return nil, err
	}
	if channelID != nil {
		if !containsString(readable, *channelID) {
			return nil, fmt.Errorf("%w: cannot search this channel", pkg.ErrForbidden)
		}
		readable = []string{*channelID}
	}

	result, err := s.searchRepo.Search(ctx, query, serverID, readable, limit, offset)
	if err != nil {
		return nil, err
	}
	for i := range result.Messages {
		if result.Messages[i].Author != nil {
			result.Messages[i].Author.AvatarURL = s.urlSigner.SignURLPtr(result.Messages[i].Author.AvatarURL)
		}
	}
	return result, nil
}

// readableChannelIDs is the same gate the message list and pins apply: ViewChannel + ReadMessages,
// resolved per channel so overrides count. A resolve error fails the search closed.
func (s *searchService) readableChannelIDs(ctx context.Context, userID, serverID string) ([]string, error) {
	channels, err := s.channels.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("list channels for search: %w", err)
	}
	ids := make([]string, 0, len(channels))
	for _, ch := range channels {
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, ch.ID)
		if err != nil {
			return nil, fmt.Errorf("resolve search permissions for channel %s: %w", ch.ID, err)
		}
		if perms.Has(models.PermViewChannel) && perms.Has(models.PermReadMessages) {
			ids = append(ids, ch.ID)
		}
	}
	return ids, nil
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
