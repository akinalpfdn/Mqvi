package services

import (
	"context"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// ChannelVisibilityChecker resolves per-user channel visibility using role overrides.
type ChannelVisibilityChecker interface {
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)
}

// UserVoiceChannelProvider returns the user's active voice channel ID.
// Used to force-include voice-connected channels in sidebar even without ViewChannel.
type UserVoiceChannelProvider interface {
	GetUserVoiceChannelID(userID string) string
}

// VoiceChannelDeleteHooks bracket a voice channel's delete. Begin before the row goes, then Finish
// after it (or Abort if the delete failed). Without them, deleting a voice channel leaves ghost
// in-memory state and a running timer, and its call can be shown to members who never could see it.
type VoiceChannelDeleteHooks interface {
	BeginChannelDelete(serverID, channelID string)
	AbortChannelDelete(serverID, channelID string)
	FinishChannelDelete(serverID, channelID string)
}

type ChannelVisibilityFilter struct {
	IsAdmin         bool
	HasBaseView     bool
	HiddenChannels  map[string]bool
	GrantedChannels map[string]bool
}

func (f *ChannelVisibilityFilter) CanSee(channelID string) bool {
	if f.IsAdmin {
		return true
	}
	if f.HiddenChannels[channelID] {
		return false
	}
	if f.GrantedChannels[channelID] {
		return true
	}
	return f.HasBaseView
}

// ChannelService handles channel CRUD. All list operations are server-scoped.
type ChannelService interface {
	GetAllGrouped(ctx context.Context, serverID, userID string) ([]models.CategoryWithChannels, error)
	Create(ctx context.Context, serverID string, req *models.CreateChannelRequest) (*models.Channel, error)
	Update(ctx context.Context, serverID string, id string, req *models.UpdateChannelRequest) (*models.Channel, error)
	Delete(ctx context.Context, serverID string, id string) error
	ReorderChannels(ctx context.Context, serverID string, req *models.ReorderChannelsRequest, userID string) ([]models.CategoryWithChannels, error)
}

type channelService struct {
	channelRepo   repository.ChannelRepository
	categoryRepo  repository.CategoryRepository
	hub           ws.Broadcaster
	visChecker    ChannelVisibilityChecker
	voiceProvider UserVoiceChannelProvider
	voiceDisc     VoiceChannelDeleteHooks
	fileCleanup   FileCleanupService
	online        ServerOnlineLister
	audience      ChannelAudienceFilter
}

func NewChannelService(
	channelRepo repository.ChannelRepository,
	categoryRepo repository.CategoryRepository,
	hub ws.Broadcaster,
	visChecker ChannelVisibilityChecker,
	voiceProvider UserVoiceChannelProvider,
	voiceDisc VoiceChannelDeleteHooks,
	fileCleanup FileCleanupService,
	online ServerOnlineLister,
	audience ChannelAudienceFilter,
) ChannelService {
	return &channelService{
		channelRepo:   channelRepo,
		categoryRepo:  categoryRepo,
		hub:           hub,
		visChecker:    visChecker,
		voiceProvider: voiceProvider,
		voiceDisc:     voiceDisc,
		fileCleanup:   fileCleanup,
		online:        online,
		audience:      audience,
	}
}

func (s *channelService) GetAllGrouped(ctx context.Context, serverID, userID string) ([]models.CategoryWithChannels, error) {
	categories, err := s.categoryRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get categories: %w", err)
	}

	channels, err := s.channelRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channels: %w", err)
	}

	filter, err := s.visChecker.BuildVisibilityFilter(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to build visibility filter: %w", err)
	}

	// Force-include the user's active voice channel even without ViewChannel
	voiceChannelID := ""
	if s.voiceProvider != nil {
		voiceChannelID = s.voiceProvider.GetUserVoiceChannelID(userID)
	}

	channelsByCategory := make(map[string][]models.Channel)
	for _, ch := range channels {
		if !filter.CanSee(ch.ID) && ch.ID != voiceChannelID {
			continue
		}
		catID := ""
		if ch.CategoryID != nil {
			catID = *ch.CategoryID
		}
		channelsByCategory[catID] = append(channelsByCategory[catID], ch)
	}

	result := make([]models.CategoryWithChannels, 0, len(categories)+1)

	// Uncategorized channels first (category_id = NULL)
	if uncategorized := channelsByCategory[""]; len(uncategorized) > 0 {
		result = append(result, models.CategoryWithChannels{
			Category: models.Category{
				ID:       "",
				ServerID: serverID,
				Name:     "",
				Position: -1,
			},
			Channels: uncategorized,
		})
	}

	for _, cat := range categories {
		chs := channelsByCategory[cat.ID]
		if len(chs) == 0 && !filter.IsAdmin {
			continue
		}
		if chs == nil {
			chs = []models.Channel{}
		}
		result = append(result, models.CategoryWithChannels{
			Category: cat,
			Channels: chs,
		})
	}

	return result, nil
}

func (s *channelService) Create(ctx context.Context, serverID string, req *models.CreateChannelRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if req.CategoryID != "" {
		if _, err := s.categoryRepo.GetByID(ctx, req.CategoryID); err != nil {
			return nil, fmt.Errorf("%w: category not found", pkg.ErrBadRequest)
		}
	}

	maxPos, err := s.channelRepo.GetMaxPosition(ctx, req.CategoryID)
	if err != nil {
		return nil, fmt.Errorf("failed to get max position: %w", err)
	}

	channel := &models.Channel{
		ServerID: serverID,
		Name:     req.Name,
		Type:     models.ChannelType(req.Type),
		Position: maxPos + 1,
	}

	if req.CategoryID != "" {
		channel.CategoryID = &req.CategoryID
	}
	if req.Topic != "" {
		channel.Topic = &req.Topic
	}
	if channel.Type == models.ChannelTypeVoice {
		channel.Bitrate = 64000
	}

	if err := s.channelRepo.Create(ctx, channel); err != nil {
		return nil, fmt.Errorf("failed to create channel: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelCreate,
		Data: nil,
	})

	return channel, nil
}

func (s *channelService) Update(ctx context.Context, serverID string, id string, req *models.UpdateChannelRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	channel, err := s.channelRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	// IDOR guard: the channel must belong to the route's server.
	if channel == nil || channel.ServerID != serverID {
		return nil, fmt.Errorf("%w: channel does not belong to this server", pkg.ErrForbidden)
	}

	if req.Name != nil {
		channel.Name = *req.Name
	}
	if req.Topic != nil {
		channel.Topic = req.Topic
	}
	if req.CategoryID != nil {
		if *req.CategoryID == "" {
			channel.CategoryID = nil
		} else {
			// The target category must exist AND live in the same server.
			cat, err := s.categoryRepo.GetByID(ctx, *req.CategoryID)
			if err != nil || cat == nil || cat.ServerID != serverID {
				return nil, fmt.Errorf("%w: category not found", pkg.ErrBadRequest)
			}
			channel.CategoryID = req.CategoryID
		}
	}

	if err := s.channelRepo.Update(ctx, channel); err != nil {
		return nil, err
	}

	// Name and topic of a hidden channel are not for members who cannot see it.
	s.hub.BroadcastToUsers(s.channelUpdateAudience(ctx, serverID, channel.ID), ws.Event{
		Op:   ws.OpChannelUpdate,
		Data: channel,
	})

	return channel, nil
}

func (s *channelService) Delete(ctx context.Context, serverID string, id string) error {
	// IDOR guard: the channel must belong to the route's server.
	channel, err := s.channelRepo.GetByID(ctx, id)
	if err != nil {
		return err
	}
	if channel == nil || channel.ServerID != serverID {
		return fmt.Errorf("%w: channel does not belong to this server", pkg.ErrForbidden)
	}

	// Phase 1: collect file refs BEFORE cascade delete
	plan, err := s.fileCleanup.CollectChannelFiles(ctx, id)
	if err != nil {
		return fmt.Errorf("failed to collect channel files: %w", err)
	}

	// Read while the overrides still exist: afterwards nobody's view of the channel can be read, and
	// a hidden channel's id is not for members who never saw it.
	audience, audienceErr := s.sidebarAudience(ctx, serverID, id)

	// The overrides go with the row, after which a hidden channel reads as visible to the base view,
	// so the call is hidden from every reader before the delete; a failed delete gives it back.
	voice := channel.Type == models.ChannelTypeVoice && s.voiceDisc != nil
	if voice {
		s.voiceDisc.BeginChannelDelete(serverID, id)
	}

	// Phase 2: DB delete (CASCADE removes attachment rows)
	if err := s.channelRepo.Delete(ctx, id); err != nil {
		if voice {
			s.voiceDisc.AbortChannelDelete(serverID, id)
		}
		return err
	}

	// Disconnect anyone still in the call — after the delete, so a failed delete never kicks anyone.
	if voice {
		s.voiceDisc.FinishChannelDelete(serverID, id)
	}

	// Phase 3: delete files from disk + release quota (safe — DB rows already gone)
	s.fileCleanup.Execute(plan)

	deleted := ws.Event{Op: ws.OpChannelDelete, Data: map[string]string{"id": id}}
	if audienceErr != nil {
		// A deleted channel's id is worth less than a channel stuck in every sidebar.
		log.Printf("[channel] delete %s: %v (told the whole server)", id, audienceErr)
		s.hub.BroadcastToServer(serverID, deleted)
	} else {
		s.hub.BroadcastToUsers(audience, deleted)
	}

	return nil
}

func (s *channelService) ReorderChannels(ctx context.Context, serverID string, req *models.ReorderChannelsRequest, userID string) ([]models.CategoryWithChannels, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// IDOR guard: the reordered channel IDs come from the request body, so every one —
	// and any cross-category move target — must belong to the route's server.
	for _, item := range req.Items {
		ch, err := s.channelRepo.GetByID(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		if ch == nil || ch.ServerID != serverID {
			return nil, fmt.Errorf("%w: channel does not belong to this server", pkg.ErrForbidden)
		}
		if item.CategoryID != nil && *item.CategoryID != "" {
			cat, err := s.categoryRepo.GetByID(ctx, *item.CategoryID)
			if err != nil || cat == nil || cat.ServerID != serverID {
				return nil, fmt.Errorf("%w: category not found", pkg.ErrBadRequest)
			}
		}
	}

	if err := s.channelRepo.UpdatePositions(ctx, req.Items); err != nil {
		return nil, fmt.Errorf("failed to update channel positions: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelReorder,
		Data: nil,
	})

	grouped, err := s.GetAllGrouped(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload channels after reorder: %w", err)
	}

	return grouped, nil
}

// channelUpdateAudience is sidebarAudience with a failed read withheld from all but the channel's
// voice participants.
func (s *channelService) channelUpdateAudience(ctx context.Context, serverID, channelID string) []string {
	audience, err := s.sidebarAudience(ctx, serverID, channelID)
	if err != nil {
		log.Printf("[channel] update %s: %v (withheld)", channelID, err)
	}
	return audience
}

// sidebarAudience is who the sidebar shows this channel to: members with ViewChannel, plus a member
// sitting in it as a voice channel (the sidebar force-includes that one, see GetAllGrouped). The
// participants are returned even when the permission read fails.
func (s *channelService) sidebarAudience(ctx context.Context, serverID, channelID string) ([]string, error) {
	audience, err := channelAudienceOrErr(ctx, s.online, s.audience, serverID, channelID, models.PermViewChannel)
	if s.voiceProvider == nil {
		return audience, err
	}
	seen := make(map[string]bool, len(audience))
	for _, uid := range audience {
		seen[uid] = true
	}
	for _, uid := range s.online.GetOnlineUserIDsForServer(serverID) {
		if !seen[uid] && s.voiceProvider.GetUserVoiceChannelID(uid) == channelID {
			audience = append(audience, uid)
		}
	}
	return audience, err
}
