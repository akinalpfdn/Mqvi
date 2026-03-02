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
// Kanal:
//   - GetOrCreateChannel: İki kullanıcı arasındaki DM kanalını bul veya oluştur
//   - ListChannels: Kullanıcının tüm DM kanallarını listele
//
// Mesaj:
//   - GetMessages: Cursor-based pagination ile mesajları getir (attachments + reactions dahil)
//   - SendMessage: Yeni DM mesajı gönder (reply desteği)
//   - BroadcastCreate: Mesajı dosya ekleri ile birlikte WS broadcast et (handler tarafından çağrılır)
//   - EditMessage: DM mesajını düzenle
//   - DeleteMessage: DM mesajını sil
//
// Reaction:
//   - ToggleReaction: Emoji tepkisi ekle/kaldır + WS broadcast
//
// Pin:
//   - PinMessage: Mesajı sabitle + WS broadcast
//   - UnpinMessage: Sabitlemeyi kaldır + WS broadcast
//   - GetPinnedMessages: Sabitlenmiş mesajları listele
//
// Search:
//   - SearchMessages: FTS5 tam metin arama
type DMService interface {
	GetOrCreateChannel(ctx context.Context, userID, otherUserID string) (*models.DMChannelWithUser, error)
	ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error)

	GetMessages(ctx context.Context, userID, channelID string, beforeID string, limit int) (*models.DMMessagePage, error)
	SendMessage(ctx context.Context, userID, channelID string, req *models.CreateDMMessageRequest) (*models.DMMessage, error)
	BroadcastCreate(message *models.DMMessage)
	EditMessage(ctx context.Context, userID, messageID string, req *models.UpdateDMMessageRequest) (*models.DMMessage, error)
	DeleteMessage(ctx context.Context, userID, messageID string) error

	ToggleReaction(ctx context.Context, userID, messageID, emoji string) error
	PinMessage(ctx context.Context, userID, messageID string) error
	UnpinMessage(ctx context.Context, userID, messageID string) error
	GetPinnedMessages(ctx context.Context, userID, channelID string) ([]models.DMMessage, error)
	SearchMessages(ctx context.Context, userID, channelID, query string, limit, offset int) (*models.DMSearchResult, error)
}

type dmService struct {
	dmRepo   repository.DMRepository
	userRepo repository.UserRepository
	hub      ws.Broadcaster
}

// NewDMService, constructor.
func NewDMService(
	dmRepo repository.DMRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
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

// broadcastToBothUsers, DM kanalının her iki kullanıcısına WS event gönderir.
// DM broadcast pattern'ı: user1 + user2 (eğer farklılarsa).
func (s *dmService) broadcastToBothUsers(channel *models.DMChannel, event ws.Event) {
	s.hub.BroadcastToUser(channel.User1ID, event)
	if channel.User1ID != channel.User2ID {
		s.hub.BroadcastToUser(channel.User2ID, event)
	}
}

// verifyChannelMembership, kullanıcının bu DM kanalının üyesi olduğunu doğrular.
// Değilse ErrForbidden döner. Başarılıysa kanal objesini döner.
func (s *dmService) verifyChannelMembership(ctx context.Context, userID, channelID string) (*models.DMChannel, error) {
	channel, err := s.dmRepo.GetChannelByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.User1ID != userID && channel.User2ID != userID {
		return nil, fmt.Errorf("%w: not a member of this DM channel", pkg.ErrForbidden)
	}
	return channel, nil
}

// verifyMessageAccess, mesajın sahibini ve kullanıcının
// bu kanalın üyesi olduğunu doğrular. Kanal objesini de döner (broadcast için).
func (s *dmService) verifyMessageAccess(ctx context.Context, userID, messageID string) (*models.DMMessage, *models.DMChannel, error) {
	msg, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return nil, nil, err
	}

	channel, err := s.verifyChannelMembership(ctx, userID, msg.DMChannelID)
	if err != nil {
		return nil, nil, err
	}

	return msg, channel, nil
}

// enrichMessages, mesaj listesine attachments ve reactions batch yükler.
// Channel message_service.go'daki batch load pattern ile aynı:
// 1. Tüm mesaj ID'lerini topla
// 2. Attachments: tek sorgu → map[messageID][]DMAttachment
// 3. Reactions: tek sorgu → map[messageID][]ReactionGroup
// 4. Her mesaja atama + null protection (boş dizi)
func (s *dmService) enrichMessages(ctx context.Context, messages []models.DMMessage) error {
	if len(messages) == 0 {
		return nil
	}

	messageIDs := make([]string, len(messages))
	for i, m := range messages {
		messageIDs[i] = m.ID
	}

	// Batch load attachments — N+1 yerine tek sorgu
	attachmentMap, err := s.dmRepo.GetAttachmentsByMessageIDs(ctx, messageIDs)
	if err != nil {
		return fmt.Errorf("failed to batch load DM attachments: %w", err)
	}

	// Batch load reactions — N+1 yerine tek sorgu
	reactionMap, err := s.dmRepo.GetReactionsByMessageIDs(ctx, messageIDs)
	if err != nil {
		return fmt.Errorf("failed to batch load DM reactions: %w", err)
	}

	// Her mesaja batch load verilerini ata
	for i := range messages {
		messages[i].Attachments = attachmentMap[messages[i].ID]
		if messages[i].Attachments == nil {
			messages[i].Attachments = []models.DMAttachment{}
		}
		messages[i].Reactions = reactionMap[messages[i].ID]
		if messages[i].Reactions == nil {
			messages[i].Reactions = []models.ReactionGroup{}
		}
	}

	return nil
}

// ─── Channel Operations ───

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
			ID:            existing.ID,
			OtherUser:     otherUser,
			CreatedAt:     existing.CreatedAt,
			LastMessageAt: existing.LastMessageAt,
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
		ID:            channel.ID,
		OtherUser:     otherUser,
		CreatedAt:     channel.CreatedAt,
		LastMessageAt: channel.LastMessageAt,
	}

	// Her iki kullanıcıya da yeni kanal bilgisi gönder.
	// Her kullanıcı kendi perspektifinden "karşı taraf" bilgisini alır.
	currentUser, err := s.userRepo.GetByID(ctx, userID)
	if err == nil {
		currentUser.PasswordHash = ""
		s.hub.BroadcastToUser(otherUserID, ws.Event{
			Op: ws.OpDMChannelCreate,
			Data: models.DMChannelWithUser{
				ID:            channel.ID,
				OtherUser:     currentUser,
				CreatedAt:     channel.CreatedAt,
				LastMessageAt: channel.LastMessageAt,
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

// ─── Message Operations ───

// GetMessages, DM kanalının mesajlarını cursor-based pagination ile döner.
// Yetki kontrolü: kullanıcı bu kanalın üyesi olmalı.
//
// Channel message_service.GetMessages ile aynı pattern:
// 1. Yetki kontrolü
// 2. limit+1 trick (hasMore)
// 3. Ters çevir (DB DESC → frontend ASC)
// 4. Batch load: attachments + reactions
func (s *dmService) GetMessages(ctx context.Context, userID, channelID string, beforeID string, limit int) (*models.DMMessagePage, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	// Yetki kontrolü — kullanıcı bu DM kanalının üyesi mi?
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
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

	// Batch load: attachments + reactions
	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}

	return &models.DMMessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// SendMessage, yeni bir DM mesajı gönderir.
//
// Channel message_service.Create ile paralel pattern:
// 1. Validate request
// 2. Yetki kontrolü (kanal üyeliği)
// 3. Reply validasyonu (varsa referans mesaj aynı kanalda mı?)
// 4. DB'ye kaydet
// 5. Yazar bilgisini yükle
// 6. Referenced message yükle (reply preview için)
// 7. Boş slice'lar ata (null protection)
//
// NOT: Dosya yükleme bu metottan sonra handler'da yapılır.
// Handler, dönen mesaja attachments ekleyip BroadcastCreate() çağırır.
func (s *dmService) SendMessage(ctx context.Context, userID, channelID string, req *models.CreateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Yetki kontrolü
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	// Reply validasyonu — referans mesaj aynı DM kanalında mı?
	if req.ReplyToID != nil && *req.ReplyToID != "" {
		refMsg, err := s.dmRepo.GetMessageByID(ctx, *req.ReplyToID)
		if err != nil {
			return nil, fmt.Errorf("%w: referenced message not found", pkg.ErrBadRequest)
		}
		if refMsg.DMChannelID != channelID {
			return nil, fmt.Errorf("%w: referenced message is not in this DM channel", pkg.ErrBadRequest)
		}
	}

	// Content boş string ise nil yap (sadece dosya mesajı durumu)
	var contentPtr *string
	if req.Content != "" {
		contentPtr = &req.Content
	}

	msg := &models.DMMessage{
		DMChannelID: channelID,
		UserID:      userID,
		Content:     contentPtr,
		ReplyToID:   req.ReplyToID,
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

	// Referenced message (reply preview) yükle
	if msg.ReplyToID != nil && *msg.ReplyToID != "" {
		refMsg, err := s.dmRepo.GetMessageByID(ctx, *msg.ReplyToID)
		if err == nil {
			ref := &models.MessageReference{
				ID:      refMsg.ID,
				Content: refMsg.Content,
			}
			if refMsg.Author != nil {
				refMsg.Author.PasswordHash = ""
				ref.Author = refMsg.Author
			}
			msg.ReferencedMessage = ref
		}
		// Hata durumunda ReferencedMessage nil kalır — frontend "silindi" gösterir
	}

	// Null protection — JSON'da null yerine [] döner
	msg.Attachments = []models.DMAttachment{}
	msg.Reactions = []models.ReactionGroup{}

	return msg, nil
}

// BroadcastCreate, oluşturulan DM mesajını dosya ekleri ile birlikte
// her iki kullanıcıya WS broadcast eder.
//
// Channel BroadcastCreate pattern ile aynı: handler dosyaları yükledikten sonra
// bu metodu çağırır — böylece WS event attachments dahil gönderilir.
func (s *dmService) BroadcastCreate(message *models.DMMessage) {
	channel, err := s.dmRepo.GetChannelByID(context.Background(), message.DMChannelID)
	if err != nil {
		return
	}

	event := ws.Event{
		Op:   ws.OpDMMessageCreate,
		Data: message,
	}
	s.broadcastToBothUsers(channel, event)
}

// EditMessage, bir DM mesajını düzenler.
// Sadece mesaj sahibi düzenleyebilir.
func (s *dmService) EditMessage(ctx context.Context, userID, messageID string, req *models.UpdateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
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

	// Attachments ve reactions yükle
	enriched := []models.DMMessage{*updated}
	if err := s.enrichMessages(ctx, enriched); err != nil {
		return nil, err
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op:   ws.OpDMMessageUpdate,
		Data: &enriched[0],
	})

	return &enriched[0], nil
}

// DeleteMessage, bir DM mesajını siler.
// Sadece mesaj sahibi silebilir.
func (s *dmService) DeleteMessage(ctx context.Context, userID, messageID string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	if msg.UserID != userID {
		return fmt.Errorf("%w: you can only delete your own messages", pkg.ErrForbidden)
	}

	if err := s.dmRepo.DeleteMessage(ctx, messageID); err != nil {
		return err
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMMessageDelete,
		Data: map[string]string{
			"id":            messageID,
			"dm_channel_id": msg.DMChannelID,
		},
	})

	return nil
}

// ─── Reaction Operations ───

// ToggleReaction, DM mesajına emoji tepkisi ekler veya kaldırır.
//
// 1. Mesaj erişim kontrolü (kullanıcı bu DM kanalının üyesi mi?)
// 2. Repository toggle (INSERT OR IGNORE → DELETE pattern)
// 3. Güncel reaction listesini yükle
// 4. Her iki kullanıcıya WS broadcast
func (s *dmService) ToggleReaction(ctx context.Context, userID, messageID, emoji string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	_, err = s.dmRepo.ToggleReaction(ctx, messageID, userID, emoji)
	if err != nil {
		return fmt.Errorf("failed to toggle DM reaction: %w", err)
	}

	// Güncel reaction listesini yükle
	reactions, err := s.dmRepo.GetReactionsByMessageID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("failed to get updated reactions: %w", err)
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMReactionUpdate,
		Data: map[string]any{
			"dm_message_id": messageID,
			"dm_channel_id": msg.DMChannelID,
			"reactions":     reactions,
		},
	})

	return nil
}

// ─── Pin Operations ───

// PinMessage, bir DM mesajını sabitler.
// DM'de her iki kullanıcı da sabitleme yapabilir (channel gibi permission yok).
func (s *dmService) PinMessage(ctx context.Context, userID, messageID string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	if err := s.dmRepo.PinMessage(ctx, messageID); err != nil {
		return fmt.Errorf("failed to pin DM message: %w", err)
	}

	// Güncel mesaj bilgisini yükle (is_pinned = true)
	updated, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("failed to get updated message: %w", err)
	}
	enriched := []models.DMMessage{*updated}
	if err := s.enrichMessages(ctx, enriched); err != nil {
		return err
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMMessagePin,
		Data: map[string]any{
			"dm_channel_id": msg.DMChannelID,
			"message":       &enriched[0],
		},
	})

	return nil
}

// UnpinMessage, bir DM mesajının sabitlemesini kaldırır.
func (s *dmService) UnpinMessage(ctx context.Context, userID, messageID string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	if err := s.dmRepo.UnpinMessage(ctx, messageID); err != nil {
		return fmt.Errorf("failed to unpin DM message: %w", err)
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMMessageUnpin,
		Data: map[string]any{
			"dm_channel_id": msg.DMChannelID,
			"message_id":    messageID,
		},
	})

	return nil
}

// GetPinnedMessages, DM kanalının sabitlenmiş mesajlarını listeler.
func (s *dmService) GetPinnedMessages(ctx context.Context, userID, channelID string) ([]models.DMMessage, error) {
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	messages, err := s.dmRepo.GetPinnedMessages(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pinned DM messages: %w", err)
	}

	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}

	return messages, nil
}

// ─── Search Operations ───

// SearchMessages, DM kanalında FTS5 tam metin araması yapar.
//
// Channel search ile aynı pattern — limit/offset ile pagination,
// total_count ile toplam sonuç sayısı döner.
// Limit validasyonu: 1-100 arası, varsayılan 25.
// Offset validasyonu: >= 0, varsayılan 0.
func (s *dmService) SearchMessages(ctx context.Context, userID, channelID, query string, limit, offset int) (*models.DMSearchResult, error) {
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	if query == "" {
		return &models.DMSearchResult{Messages: []models.DMMessage{}, TotalCount: 0}, nil
	}

	// Limit/offset validation — channel search_service ile aynı
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	messages, totalCount, err := s.dmRepo.SearchMessages(ctx, channelID, query, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("failed to search DM messages: %w", err)
	}

	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}

	return &models.DMSearchResult{Messages: messages, TotalCount: totalCount}, nil
}
