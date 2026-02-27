package services

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// mentionRegex, mesaj içeriğindeki @username kalıplarını bulur.
//
// Regex açıklaması:
// @        — literal @ karakteri (mention başlangıcı)
// (\w+)   — bir veya daha fazla kelime karakteri (harf, rakam, _)
//
// Örnekler:
//   "merhaba @ali nasılsın"  → ["ali"]
//   "@ali ve @veli"           → ["ali", "veli"]
//   "email@test.com"          → ["test"] — false positive, ama service katmanında
//                               username lookup ile doğrulanır (DB'de "test" yoksa skip)
var mentionRegex = regexp.MustCompile(`@(\w+)`)

// MessageService, mesaj iş mantığı interface'i.
type MessageService interface {
	GetByChannelID(ctx context.Context, channelID string, userID string, beforeID string, limit int) (*models.MessagePage, error)
	Create(ctx context.Context, channelID string, userID string, req *models.CreateMessageRequest) (*models.Message, error)
	BroadcastCreate(message *models.Message)
	Update(ctx context.Context, id string, userID string, req *models.UpdateMessageRequest) (*models.Message, error)
	Delete(ctx context.Context, id string, userID string, userPermissions models.Permission) error
}

type messageService struct {
	messageRepo    repository.MessageRepository
	attachmentRepo repository.AttachmentRepository
	channelRepo    repository.ChannelRepository
	userRepo       repository.UserRepository
	mentionRepo    repository.MentionRepository
	reactionRepo   repository.ReactionRepository
	hub            ws.EventPublisher
	permResolver   ChannelPermResolver
}

// NewMessageService, constructor.
// reactionRepo: Mesajlar listelenirken reaction'ları batch yüklemek için gerekir.
// permResolver: Kanal bazlı permission override kontrolü (SendMessages, ReadMessages).
func NewMessageService(
	messageRepo repository.MessageRepository,
	attachmentRepo repository.AttachmentRepository,
	channelRepo repository.ChannelRepository,
	userRepo repository.UserRepository,
	mentionRepo repository.MentionRepository,
	reactionRepo repository.ReactionRepository,
	hub ws.EventPublisher,
	permResolver ChannelPermResolver,
) MessageService {
	return &messageService{
		messageRepo:    messageRepo,
		attachmentRepo: attachmentRepo,
		channelRepo:    channelRepo,
		userRepo:       userRepo,
		mentionRepo:    mentionRepo,
		reactionRepo:   reactionRepo,
		hub:            hub,
		permResolver:   permResolver,
	}
}

// GetByChannelID, belirli bir kanalın mesajlarını cursor-based pagination ile döner.
//
// Kanal bazlı ReadMessages permission kontrolü yapılır.
// Override ile deny edilmişse kullanıcı bu kanalın mesajlarını göremez.
func (s *messageService) GetByChannelID(ctx context.Context, channelID string, userID string, beforeID string, limit int) (*models.MessagePage, error) {
	// Kanal bazlı ReadMessages kontrolü
	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !channelPerms.Has(models.PermReadMessages) {
		return nil, fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
	}

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

		// Mention'ları batch yükle (N+1 önleme)
		mentionMap, err := s.mentionRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get mentions: %w", err)
		}

		// Reaction'ları batch yükle (N+1 önleme)
		reactionMap, err := s.reactionRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get reactions: %w", err)
		}

		for i := range messages {
			messages[i].Attachments = attachmentMap[messages[i].ID]
			if messages[i].Attachments == nil {
				messages[i].Attachments = []models.Attachment{} // null yerine boş dizi
			}
			messages[i].Mentions = mentionMap[messages[i].ID]
			if messages[i].Mentions == nil {
				messages[i].Mentions = []string{} // null yerine boş dizi
			}
			messages[i].Reactions = reactionMap[messages[i].ID]
			if messages[i].Reactions == nil {
				messages[i].Reactions = []models.ReactionGroup{} // null yerine boş dizi
			}
		}
	}

	// Go'da nil slice JSON'a "null" olarak serialize edilir, frontend "null.map()" ile crash eder.
	// Boş kanalda (hiç mesaj yok) messages nil olabilir — boş slice'a çevir.
	if messages == nil {
		messages = []models.Message{}
	}

	return &models.MessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// Create, yeni bir mesaj oluşturur ve tüm bağlı kullanıcılara bildirir.
//
// Kanal bazlı SendMessages permission kontrolü yapılır.
// Override ile deny edilmişse kullanıcı bu kanala mesaj gönderemez.
func (s *messageService) Create(ctx context.Context, channelID string, userID string, req *models.CreateMessageRequest) (*models.Message, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Kanal var mı kontrol et
	if _, err := s.channelRepo.GetByID(ctx, channelID); err != nil {
		return nil, err
	}

	// Kanal bazlı SendMessages kontrolü
	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !channelPerms.Has(models.PermSendMessages) {
		return nil, fmt.Errorf("%w: missing send messages permission for this channel", pkg.ErrForbidden)
	}

	message := &models.Message{
		ChannelID: channelID,
		UserID:    userID,
		Content:   &req.Content,
	}

	// Reply validation — yanıt yapılan mesajın aynı kanalda var olduğunu doğrula
	if req.ReplyToID != nil && *req.ReplyToID != "" {
		refMsg, err := s.messageRepo.GetByID(ctx, *req.ReplyToID)
		if err != nil {
			return nil, fmt.Errorf("%w: referenced message not found", pkg.ErrBadRequest)
		}
		if refMsg.ChannelID != channelID {
			return nil, fmt.Errorf("%w: cannot reply to a message in a different channel", pkg.ErrBadRequest)
		}
		message.ReplyToID = req.ReplyToID
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
	message.Reactions = []models.ReactionGroup{} // Yeni mesajda reaction yok

	// Yanıt bilgisini yükle (API response ve WS broadcast için)
	if message.ReplyToID != nil {
		refMsg, err := s.messageRepo.GetByID(ctx, *message.ReplyToID)
		if err == nil && refMsg != nil {
			message.ReferencedMessage = &models.MessageReference{
				ID:      refMsg.ID,
				Author:  refMsg.Author,
				Content: refMsg.Content,
			}
		}
		// err durumunda (mesaj silinmiş olabilir) ReferencedMessage nil kalır
	}

	// Mention'ları parse et ve kaydet
	mentionedIDs := s.extractMentions(ctx, req.Content)
	if len(mentionedIDs) > 0 {
		if err := s.mentionRepo.SaveMentions(ctx, message.ID, mentionedIDs); err != nil {
			// Mention kaydetme hatası mesaj oluşturmayı engellemez — log yeterli
			fmt.Printf("[mention] failed to save mentions for message %s: %v\n", message.ID, err)
		}
	}
	message.Mentions = mentionedIDs

	// NOT: WS broadcast burada yapılmıyor.
	// Multipart mesajlarda dosyalar handler'da yüklenir.
	// Broadcast, handler'da dosya yükleme tamamlandıktan sonra yapılır —
	// böylece WS event'i attachment bilgileriyle birlikte gider.

	return message, nil
}

// BroadcastCreate, mesaj oluşturulduktan sonra WS broadcast yapar.
//
// Neden ayrı metod?
// Multipart mesajlarda dosyalar handler'da yüklenir (service dosya I/O bilmez).
// Handler önce Create ile mesajı oluşturur, sonra dosyaları yükler,
// son olarak BroadcastCreate ile attachment'lı mesajı broadcast eder.
//
// Güvenlik: Mesaj sadece ViewChannel yetkisi olan kullanıcılara gönderilir.
// Hub'daki online kullanıcı listesi alınır, her biri için kanal bazlı
// permission kontrol edilir. Yetkisi olmayana mesaj içeriği bile ulaşmaz.
func (s *messageService) BroadcastCreate(message *models.Message) {
	event := ws.Event{
		Op:   ws.OpMessageCreate,
		Data: message,
	}

	// Online kullanıcıları al ve ViewChannel yetkisi olanları filtrele
	onlineUsers := s.hub.GetOnlineUserIDs()
	ctx := context.Background()
	var allowed []string

	for _, userID := range onlineUsers {
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, message.ChannelID)
		if err != nil {
			continue // Hata durumunda güvenli tarafta kal — gönderme
		}
		if perms.Has(models.PermViewChannel) {
			allowed = append(allowed, userID)
		}
	}

	s.hub.BroadcastToUsers(allowed, event)
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

	// Mention'ları yeniden parse et (mesaj düzenlendiğinde mention'lar değişmiş olabilir)
	// Önce mevcut mention'ları sil, sonra yenilerini kaydet
	if err := s.mentionRepo.DeleteByMessageID(ctx, id); err != nil {
		fmt.Printf("[mention] failed to delete old mentions for message %s: %v\n", id, err)
	}
	mentionedIDs := s.extractMentions(ctx, req.Content)
	if len(mentionedIDs) > 0 {
		if err := s.mentionRepo.SaveMentions(ctx, id, mentionedIDs); err != nil {
			fmt.Printf("[mention] failed to save mentions for message %s: %v\n", id, err)
		}
	}
	message.Mentions = mentionedIDs

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

// extractMentions, mesaj içeriğindeki @username kalıplarını parse eder ve
// geçerli kullanıcı ID'lerini döner.
//
// Nasıl çalışır:
// 1. Regex ile tüm @username kalıplarını bul
// 2. Her username için DB'de kullanıcı ara (UserRepository.GetByUsername)
// 3. Bulunan kullanıcıların ID'lerini döndür
// 4. Bulunamayanları sessizce atla (yanlış pozitif veya silinmiş kullanıcı)
//
// Duplicate önleme: Aynı kullanıcı birden fazla kez bahsedilirse
// ID listesinde tek sefer görünür (seen map ile kontrol).
func (s *messageService) extractMentions(ctx context.Context, content string) []string {
	matches := mentionRegex.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return []string{}
	}

	seen := make(map[string]bool)
	var userIDs []string

	for _, match := range matches {
		username := strings.ToLower(match[1])
		if seen[username] {
			continue
		}
		seen[username] = true

		user, err := s.userRepo.GetByUsername(ctx, username)
		if err != nil {
			continue // Kullanıcı bulunamadı — false positive, skip
		}
		userIDs = append(userIDs, user.ID)
	}

	if userIDs == nil {
		userIDs = []string{}
	}
	return userIDs
}
