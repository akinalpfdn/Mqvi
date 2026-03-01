package services

import (
	"context"
	"fmt"
	"unicode/utf8"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// MaxEmojiLength, bir emoji string'inin maksimum karakter uzunluğu.
// Çoğu emoji 1-2 codepoint'tir ama bazı bileşik emojiler (aile, bayrak vb.)
// 10+ codepoint olabilir. 32 karakter geniş bir güvenlik marjı sağlar.
const MaxEmojiLength = 32

// ReactionService, emoji reaction iş mantığı interface'i.
//
// ToggleReaction: Bir reaction'ı ekler veya kaldırır (toggle pattern).
// Mesajın varlığını doğrular, emoji'yi validate eder,
// toggle işlemini yapar ve WS broadcast gönderir.
type ReactionService interface {
	ToggleReaction(ctx context.Context, messageID, userID, emoji string) error
}

type reactionService struct {
	reactionRepo repository.ReactionRepository
	messageRepo  repository.MessageRepository
	hub          ws.Broadcaster
}

// NewReactionService, constructor.
// messageRepo: Toggle öncesi mesajın var olduğunu ve channel_id'sini doğrulamak için gerekir.
// hub: Reaction değişikliklerini tüm client'lara broadcast etmek için gerekir.
func NewReactionService(
	reactionRepo repository.ReactionRepository,
	messageRepo repository.MessageRepository,
	hub ws.Broadcaster,
) ReactionService {
	return &reactionService{
		reactionRepo: reactionRepo,
		messageRepo:  messageRepo,
		hub:          hub,
	}
}

// ToggleReaction, bir mesaja emoji reaction ekler veya kaldırır.
//
// Akış:
// 1. Emoji validation — boş veya çok uzun emoji'leri reddet
// 2. Mesaj varlık kontrolü — mesaj yoksa 404
// 3. Toggle — repository'de INSERT or DELETE
// 4. Güncel reaction listesini al — broadcast için
// 5. WS broadcast — tüm bağlı client'ları bilgilendir
//
// Toggle pattern: Aynı endpoint'e tekrar çağrılırsa reaction kaldırılır.
// Bu sayede frontend tek bir "react" butonuyla hem ekle hem kaldır yapabilir.
func (s *reactionService) ToggleReaction(ctx context.Context, messageID, userID, emoji string) error {
	// 1. Emoji validation
	if emoji == "" {
		return fmt.Errorf("%w: emoji is required", pkg.ErrBadRequest)
	}
	if utf8.RuneCountInString(emoji) > MaxEmojiLength {
		return fmt.Errorf("%w: emoji too long", pkg.ErrBadRequest)
	}

	// 2. Mesaj var mı kontrol et (channel_id broadcast için gerekli)
	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}

	// 3. Toggle (ekle veya kaldır) — added true ise reaction eklendi, false ise kaldırıldı
	added, err := s.reactionRepo.Toggle(ctx, messageID, userID, emoji)
	if err != nil {
		return fmt.Errorf("failed to toggle reaction: %w", err)
	}

	// 4. Güncel reaction listesini al
	reactions, err := s.reactionRepo.GetByMessageID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("failed to get reactions after toggle: %w", err)
	}

	// 5. WS broadcast — tüm client'lara reaction güncelleme gönder
	// actor_id: kim react etti, message_author_id: mesaj sahibi, added: ekleme mi kaldırma mı
	// Frontend bu bilgiyle "başkası benim mesajıma react ekledi → unread" kararı verir.
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpReactionUpdate,
		Data: map[string]any{
			"message_id":        messageID,
			"channel_id":        message.ChannelID,
			"reactions":         reactions,
			"actor_id":          userID,
			"message_author_id": message.UserID,
			"added":             added,
		},
	})

	return nil
}
