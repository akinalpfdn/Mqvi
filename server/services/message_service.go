package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// MessageService, mesaj iş mantığı interface'i.
type MessageService interface {
	GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) (*models.MessagePage, error)
	Create(ctx context.Context, channelID string, userID string, req *models.CreateMessageRequest) (*models.Message, error)
	Update(ctx context.Context, id string, userID string, req *models.UpdateMessageRequest) (*models.Message, error)
	Delete(ctx context.Context, id string, userID string, userPermissions models.Permission) error
}

type messageService struct {
	messageRepo    repository.MessageRepository
	attachmentRepo repository.AttachmentRepository
	channelRepo    repository.ChannelRepository
	userRepo       repository.UserRepository
	hub            ws.EventPublisher
}

// NewMessageService, constructor.
func NewMessageService(
	messageRepo repository.MessageRepository,
	attachmentRepo repository.AttachmentRepository,
	channelRepo repository.ChannelRepository,
	userRepo repository.UserRepository,
	hub ws.EventPublisher,
) MessageService {
	return &messageService{
		messageRepo:    messageRepo,
		attachmentRepo: attachmentRepo,
		channelRepo:    channelRepo,
		userRepo:       userRepo,
		hub:            hub,
	}
}

// GetByChannelID, belirli bir kanalın mesajlarını cursor-based pagination ile döner.
func (s *messageService) GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) (*models.MessagePage, error) {
	// Limit kontrolü
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	// limit + 1 iste — fazladan 1 satır gelirse "daha var" anlamına gelir
	messages, err := s.messageRepo.GetByChannelID(ctx, channelID, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to get messages: %w", err)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit] // Fazla satırı çıkar
	}

	// Mesajları ters çevir — DB'den DESC gelir, frontend ASC bekler (en eski üstte)
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	// Attachment'ları batch yükle (N+1 problemi önleme)
	if len(messages) > 0 {
		messageIDs := make([]string, len(messages))
		for i, m := range messages {
			messageIDs[i] = m.ID
		}

		attachments, err := s.attachmentRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get attachments: %w", err)
		}

		// Attachment'ları mesajlarla eşleştir
		attachmentMap := make(map[string][]models.Attachment)
		for _, a := range attachments {
			attachmentMap[a.MessageID] = append(attachmentMap[a.MessageID], a)
		}

		for i := range messages {
			messages[i].Attachments = attachmentMap[messages[i].ID]
			if messages[i].Attachments == nil {
				messages[i].Attachments = []models.Attachment{} // null yerine boş dizi
			}
		}
	}

	return &models.MessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// Create, yeni bir mesaj oluşturur ve tüm bağlı kullanıcılara bildirir.
func (s *messageService) Create(ctx context.Context, channelID string, userID string, req *models.CreateMessageRequest) (*models.Message, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Kanal var mı kontrol et
	if _, err := s.channelRepo.GetByID(ctx, channelID); err != nil {
		return nil, err
	}

	message := &models.Message{
		ChannelID: channelID,
		UserID:    userID,
		Content:   &req.Content,
	}

	if err := s.messageRepo.Create(ctx, message); err != nil {
		return nil, fmt.Errorf("failed to create message: %w", err)
	}

	// Yazar bilgisini yükle (API response ve WS broadcast için)
	author, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get message author: %w", err)
	}
	author.PasswordHash = "" // Güvenlik
	message.Author = author
	message.Attachments = []models.Attachment{} // Boş dizi

	// WebSocket broadcast — tüm bağlı kullanıcılar yeni mesajı görür
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMessageCreate,
		Data: message,
	})

	return message, nil
}

// Update, bir mesajı düzenler.
// Sadece mesaj sahibi düzenleyebilir.
func (s *messageService) Update(ctx context.Context, id string, userID string, req *models.UpdateMessageRequest) (*models.Message, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	message, err := s.messageRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Sahiplik kontrolü — sadece kendi mesajını düzenleyebilirsin
	if message.UserID != userID {
		return nil, fmt.Errorf("%w: you can only edit your own messages", pkg.ErrForbidden)
	}

	message.Content = &req.Content
	if err := s.messageRepo.Update(ctx, message); err != nil {
		return nil, err
	}

	// Attachment'ları yükle
	attachments, err := s.attachmentRepo.GetByMessageID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get attachments: %w", err)
	}
	message.Attachments = attachments
	if message.Attachments == nil {
		message.Attachments = []models.Attachment{}
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMessageUpdate,
		Data: message,
	})

	return message, nil
}

// Delete, bir mesajı siler.
// Mesaj sahibi VEYA MANAGE_MESSAGES yetkisi olan kullanıcılar silebilir.
func (s *messageService) Delete(ctx context.Context, id string, userID string, userPermissions models.Permission) error {
	message, err := s.messageRepo.GetByID(ctx, id)
	if err != nil {
		return err
	}

	// Yetki kontrolü: mesaj sahibi VEYA MANAGE_MESSAGES yetkisi
	if message.UserID != userID && !userPermissions.Has(models.PermManageMessages) {
		return fmt.Errorf("%w: you can only delete your own messages", pkg.ErrForbidden)
	}

	if err := s.messageRepo.Delete(ctx, id); err != nil {
		return err
	}

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpMessageDelete,
		Data: map[string]string{
			"id":         id,
			"channel_id": message.ChannelID,
		},
	})

	return nil
}
