package services

import (
	"context"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// ServerPresenceCounter reports how many distinct users are currently connected per server,
// in a single call (one hub read lock for the whole page). Implemented by the WS hub.
type ServerPresenceCounter interface {
	GetOnlineCountsForServers(serverIDs []string) map[string]int
}

// DiscoveryService powers the public server directory: filtered/searched listing and single-card
// preview. It signs icon/banner URLs and fills live online counts from the hub.
type DiscoveryService interface {
	ListPublicServers(ctx context.Context, params models.PublicServerListParams) (models.PublicServerListPage, error)
	GetPublicServer(ctx context.Context, serverID, requestingUserID string) (*models.PublicServerListItem, error)
}

type discoveryService struct {
	repo      repository.DiscoveryRepository
	presence  ServerPresenceCounter
	urlSigner FileURLSigner
}

func NewDiscoveryService(repo repository.DiscoveryRepository, presence ServerPresenceCounter, urlSigner FileURLSigner) DiscoveryService {
	return &discoveryService{repo: repo, presence: presence, urlSigner: urlSigner}
}

func (s *discoveryService) ListPublicServers(ctx context.Context, params models.PublicServerListParams) (models.PublicServerListPage, error) {
	page, err := s.repo.ListPublicServers(ctx, params)
	if err != nil {
		return models.PublicServerListPage{}, err
	}

	ids := make([]string, len(page.Items))
	for i := range page.Items {
		ids[i] = page.Items[i].ID
	}
	counts := s.presence.GetOnlineCountsForServers(ids)

	for i := range page.Items {
		s.signURLs(&page.Items[i])
		page.Items[i].OnlineCount = counts[page.Items[i].ID]
	}
	return page, nil
}

func (s *discoveryService) GetPublicServer(ctx context.Context, serverID, requestingUserID string) (*models.PublicServerListItem, error) {
	item, err := s.repo.GetPublicServerItem(ctx, serverID, requestingUserID)
	if err != nil {
		return nil, err
	}
	s.signURLs(item)
	item.OnlineCount = s.presence.GetOnlineCountsForServers([]string{item.ID})[item.ID]
	return item, nil
}

// signURLs signs the card's image URLs (stored unsigned).
func (s *discoveryService) signURLs(item *models.PublicServerListItem) {
	item.IconURL = s.urlSigner.SignURLPtr(item.IconURL)
	item.BannerURL = s.urlSigner.SignURLPtr(item.BannerURL)
}
