package services

import (
	"context"
	"fmt"
	"slices"
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
	permResolver UserChannelsPermResolver
	urlSigner    FileURLSigner
}

func NewSearchService(
	searchRepo repository.SearchRepository,
	channels SearchChannelLister,
	permResolver UserChannelsPermResolver,
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
		if !slices.Contains(readable, *channelID) {
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
// with overrides counted, for every channel in two queries. A resolve error fails the search closed.
func (s *searchService) readableChannelIDs(ctx context.Context, userID, serverID string) ([]string, error) {
	channels, err := s.channels.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("list channels for search: %w", err)
	}
	all := make([]string, len(channels))
	for i, ch := range channels {
		all[i] = ch.ID
	}
	perms, err := s.permResolver.ResolveUserChannelsPermissions(ctx, userID, serverID, all)
	if err != nil {
		return nil, fmt.Errorf("resolve search permissions: %w", err)
	}
	ids := make([]string, 0, len(all))
	for _, id := range all {
		if perms[id].Has(models.PermViewChannel) && perms[id].Has(models.PermReadMessages) {
			ids = append(ids, id)
		}
	}
	return ids, nil
}
