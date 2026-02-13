package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// DMService, DM iş mantığı interface'i.
//
// GetOrCreateChannel: İki kullanıcı arasındaki DM kanalını bul veya oluştur.
// ListChannels: Kullanıcının tüm DM kanallarını listele.
// GetMessages: Cursor-based pagination ile mesajları getir.
// SendMessage: Yeni DM mesajı gönder ve karşı tarafa WS ile bildir.
// EditMessage: DM mesajını düzenle.
// DeleteMessage: DM mesajını sil.
type DMService interface {
	GetOrCreateChannel(ctx context.Context, userID, otherUserID string) (*models.DMChannelWithUser, error)
	ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error)
	GetMessages(ctx context.Context, userID, channelID string, beforeID string, limit int) (*models.DMMessagePage, error)
	SendMessage(ctx context.Context, userID, channelID string, req *models.CreateDMMessageRequest) (*models.DMMessage, error)
	EditMessage(ctx context.Context, userID, messageID string, req *models.UpdateDMMessageRequest) (*models.DMMessage, error)
	DeleteMessage(ctx context.Context, userID, messageID string) error
}

type dmService struct {
	dmRepo   repository.DMRepository
	userRepo repository.UserRepository
	hub      ws.EventPublisher
}

// NewDMService, constructor.
func NewDMService(
	dmRepo repository.DMRepository,
	userRepo repository.UserRepository,
	hub ws.EventPublisher,
) DMService {
	return &dmService{
		dmRepo:   dmRepo,
		userRepo: userRepo,
		hub:      hub,
	}
}

// sortUserIDs, iki userID'yi sıralı döndürür.
// DM kanalı UNIQUE(user1_id, user2_id) constraint'i kullanır.
// Her zaman aynı sıralamayla kaydetmek aynı çiftin tek kanalı olmasını sağlar.
func sortUserIDs(a, b string) (string, string) {
	if a < b {
		return a, b
	}
	return b, a
}

// GetOrCreateChannel, iki kullanıcı arasındaki DM kanalını bulur.
// Yoksa yeni bir kanal oluşturur ve her iki kullanıcıya WS ile bildirir.
func (s *dmService) GetOrCreateChannel(ctx context.Context, userID, otherUserID string) (*models.DMChannelWithUser, error) {
	if userID == otherUserID {
		return nil, fmt.Errorf("%w: cannot create DM with yourself", pkg.ErrBadRequest)
	}

	// Karşı taraf var mı kontrol et
	otherUser, err := s.userRepo.GetByID(ctx, otherUserID)
	if err != nil {
		return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}

	user1, user2 := sortUserIDs(userID, otherUserID)

	// Mevcut kanalı bul
	existing, err := s.dmRepo.GetChannelByUsers(ctx, user1, user2)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing DM channel: %w", err)
	}

	if existing != nil {
		// Kanal zaten var
		otherUser.PasswordHash = ""
		return &models.DMChannelWithUser{
			ID:        existing.ID,
			OtherUser: otherUser,
			CreatedAt: existing.CreatedAt,
		}, nil
	}

	// Yeni kanal oluştur
	channel := &models.DMChannel{
		User1ID: user1,
		User2ID: user2,
	}
	if err := s.dmRepo.CreateChannel(ctx, channel); err != nil {
		return nil, fmt.Errorf("failed to create DM channel: %w", err)
	}

	result := &models.DMChannelWithUser{
		ID:        channel.ID,
		OtherUser: otherUser,
		CreatedAt: channel.CreatedAt,
	}

	// Her iki kullanıcıya da yeni kanal bilgisi gönder.
	// Her kullanıcı kendi perspektifinden "karşı taraf" bilgisini alır.
	currentUser, err := s.userRepo.GetByID(ctx, userID)
	if err == nil {
		currentUser.PasswordHash = ""
		s.hub.BroadcastToUser(otherUserID, ws.Event{
			Op: ws.OpDMChannelCreate,
			Data: models.DMChannelWithUser{
				ID:        channel.ID,
				OtherUser: currentUser,
				CreatedAt: channel.CreatedAt,
			},
		})
	}

	// Kanal oluşturana da bildir (kendi diğer tab'ları için)
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDMChannelCreate,
		Data: result,
	})

	return result, nil
}

// ListChannels, kullanıcının tüm DM kanallarını listeler.
func (s *dmService) ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error) {
	return s.dmRepo.ListChannels(ctx, userID)
}

// GetMessages, DM kanalının mesajlarını cursor-based pagination ile döner.
// Yetki kontrolü: kullanıcı bu kanalın üyesi olmalı.
func (s *dmService) GetMessages(ctx context.Context, userID, channelID string, beforeID string, limit int) (*models.DMMessagePage, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	// Yetki kontrolü — kullanıcı bu DM kanalının üyesi mi?
	channel, err := s.dmRepo.GetChannelByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.User1ID != userID && channel.User2ID != userID {
		return nil, fmt.Errorf("%w: not a member of this DM channel", pkg.ErrForbidden)
	}

	messages, err := s.dmRepo.GetMessages(ctx, channelID, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to get DM messages: %w", err)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	// Ters çevir (DB'den DESC gelir, frontend ASC bekler)
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	return &models.DMMessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// SendMessage, yeni bir DM mesajı gönderir ve her iki tarafa WS ile bildirir.
func (s *dmService) SendMessage(ctx context.Context, userID, channelID string, req *models.CreateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Yetki kontrolü
	channel, err := s.dmRepo.GetChannelByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.User1ID != userID && channel.User2ID != userID {
		return nil, fmt.Errorf("%w: not a member of this DM channel", pkg.ErrForbidden)
	}

	msg := &models.DMMessage{
		DMChannelID: channelID,
		UserID:      userID,
		Content:     &req.Content,
	}

	if err := s.dmRepo.CreateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("failed to create DM message: %w", err)
	}

	// Yazar bilgisini yükle
	author, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get message author: %w", err)
	}
	author.PasswordHash = ""
	msg.Author = author

	// Her iki tarafa da mesajı gönder
	event := ws.Event{
		Op:   ws.OpDMMessageCreate,
		Data: msg,
	}
	s.hub.BroadcastToUser(channel.User1ID, event)
	if channel.User1ID != channel.User2ID {
		s.hub.BroadcastToUser(channel.User2ID, event)
	}

	return msg, nil
}

// EditMessage, bir DM mesajını düzenler.
// Sadece mesaj sahibi düzenleyebilir.
func (s *dmService) EditMessage(ctx context.Context, userID, messageID string, req *models.UpdateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	msg, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return nil, err
	}

	if msg.UserID != userID {
		return nil, fmt.Errorf("%w: you can only edit your own messages", pkg.ErrForbidden)
	}

	if err := s.dmRepo.UpdateMessage(ctx, messageID, req.Content); err != nil {
		return nil, err
	}

	// Güncellenmiş mesajı tekrar yükle (edited_at güncel olsun)
	updated, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return nil, err
	}

	// Kanalın her iki tarafına da mesaj güncelleme gönder
	channel, err := s.dmRepo.GetChannelByID(ctx, msg.DMChannelID)
	if err == nil {
		event := ws.Event{
			Op:   ws.OpDMMessageUpdate,
			Data: updated,
		}
		s.hub.BroadcastToUser(channel.User1ID, event)
		if channel.User1ID != channel.User2ID {
			s.hub.BroadcastToUser(channel.User2ID, event)
		}
	}

	return updated, nil
}

// DeleteMessage, bir DM mesajını siler.
// Sadece mesaj sahibi silebilir.
func (s *dmService) DeleteMessage(ctx context.Context, userID, messageID string) error {
	msg, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return err
	}

	if msg.UserID != userID {
		return fmt.Errorf("%w: you can only delete your own messages", pkg.ErrForbidden)
	}

	if err := s.dmRepo.DeleteMessage(ctx, messageID); err != nil {
		return err
	}

	// Kanalın her iki tarafına da silme event'i gönder
	channel, err := s.dmRepo.GetChannelByID(ctx, msg.DMChannelID)
	if err == nil {
		event := ws.Event{
			Op: ws.OpDMMessageDelete,
			Data: map[string]string{
				"id":            messageID,
				"dm_channel_id": msg.DMChannelID,
			},
		}
		s.hub.BroadcastToUser(channel.User1ID, event)
		if channel.User1ID != channel.User2ID {
			s.hub.BroadcastToUser(channel.User2ID, event)
		}
	}

	return nil
}
