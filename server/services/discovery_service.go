package services

import (
	"context"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// ServerPresenceCounter reports how many distinct users are currently connected to a server.
// Implemented by the WS hub (GetOnlineUserIDsForServer).
type ServerPresenceCounter interface {
	GetOnlineUserIDsForServer(serverID string) []string
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
	for i := range page.Items {
		s.enrich(&page.Items[i])
	}
	return page, nil
}

func (s *discoveryService) GetPublicServer(ctx context.Context, serverID, requestingUserID string) (*models.PublicServerListItem, error) {
	item, err := s.repo.GetPublicServerItem(ctx, serverID, requestingUserID)
	if err != nil {
		return nil, err
	}
	s.enrich(item)
	return item, nil
}

// enrich signs image URLs and fills the live online count (not available from SQL).
func (s *discoveryService) enrich(item *models.PublicServerListItem) {
	item.IconURL = s.urlSigner.SignURLPtr(item.IconURL)
	item.BannerURL = s.urlSigner.SignURLPtr(item.BannerURL)
	item.OnlineCount = len(s.presence.GetOnlineUserIDsForServer(item.ID))
}
