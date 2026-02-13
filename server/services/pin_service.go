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

// MaxPinsPerChannel, bir kanalda aynı anda bulunabilecek maksimum pin sayısı.
// Discord'daki limit 50'dir — aynı sınırı uyguluyoruz.
const MaxPinsPerChannel = 50

// PinService, mesaj sabitleme iş mantığı interface'i.
//
// Pin: Mesajı sabitler — mesajın varlığını, kanalını ve pin limitini kontrol eder.
// Unpin: Pin'i kaldırır.
// GetPinnedMessages: Bir kanalın tüm pinlenmiş mesajlarını döner.
type PinService interface {
	Pin(ctx context.Context, messageID string, channelID string, pinnedBy string) (*models.PinnedMessageWithDetails, error)
	Unpin(ctx context.Context, messageID string, channelID string) error
	GetPinnedMessages(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error)
}

type pinService struct {
	pinRepo     repository.PinRepository
	messageRepo repository.MessageRepository
	hub         ws.EventPublisher
}

// NewPinService, constructor.
// messageRepo: Pin edilecek mesajın varlığını ve kanalını doğrulamak için gerekir.
// hub: Pin/unpin event'lerini tüm client'lara broadcast etmek için gerekir.
func NewPinService(
	pinRepo repository.PinRepository,
	messageRepo repository.MessageRepository,
	hub ws.EventPublisher,
) PinService {
	return &pinService{
		pinRepo:     pinRepo,
		messageRepo: messageRepo,
		hub:         hub,
	}
}

// Pin, bir mesajı sabitler.
//
// İş mantığı:
// 1. Mesajın varlığını kontrol et (GetByID)
// 2. Mesajın doğru kanala ait olduğunu kontrol et
// 3. Kanal başına pin limitini kontrol et (MaxPinsPerChannel)
// 4. Pin kaydını oluştur
// 5. WS broadcast — tüm kullanıcılar pin'i gerçek zamanlı görür
func (s *pinService) Pin(ctx context.Context, messageID string, channelID string, pinnedBy string) (*models.PinnedMessageWithDetails, error) {
	// Mesaj var mı ve doğru kanala mı ait?
	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return nil, err
	}
	if message.ChannelID != channelID {
		return nil, fmt.Errorf("%w: message does not belong to this channel", pkg.ErrBadRequest)
	}

	// Pin limiti kontrolü
	count, err := s.pinRepo.CountByChannelID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to check pin count: %w", err)
	}
	if count >= MaxPinsPerChannel {
		return nil, fmt.Errorf("%w: channel has reached the maximum number of pins (%d)", pkg.ErrBadRequest, MaxPinsPerChannel)
	}

	// Pin kaydı oluştur
	pin := &models.PinnedMessage{
		MessageID: messageID,
		ChannelID: channelID,
		PinnedBy:  pinnedBy,
	}
	if err := s.pinRepo.Pin(ctx, pin); err != nil {
		return nil, err
	}

	// Detaylı pin bilgisi — broadcast ve response için
	// GetByChannelID yerine tekil dönüş: mesaj bilgisi zaten elimizde
	result := &models.PinnedMessageWithDetails{
		PinnedMessage: *pin,
		Message:       message,
	}

	// WS broadcast — tüm kullanıcılar pin'i gerçek zamanlı görür
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMessagePin,
		Data: result,
	})
	log.Printf("[pin] message %s pinned in channel %s by user %s", messageID, channelID, pinnedBy)

	return result, nil
}

// Unpin, bir mesajın pin'ini kaldırır.
//
// İş mantığı:
// 1. Mesajın varlığını kontrol et
// 2. Mesajın doğru kanala ait olduğunu kontrol et
// 3. Pin kaydını sil
// 4. WS broadcast — tüm kullanıcılar unpin'i gerçek zamanlı görür
func (s *pinService) Unpin(ctx context.Context, messageID string, channelID string) error {
	// Mesaj var mı ve doğru kanala mı ait?
	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}
	if message.ChannelID != channelID {
		return fmt.Errorf("%w: message does not belong to this channel", pkg.ErrBadRequest)
	}

	if err := s.pinRepo.Unpin(ctx, messageID); err != nil {
		return err
	}

	// WS broadcast
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpMessageUnpin,
		Data: map[string]string{
			"message_id": messageID,
			"channel_id": channelID,
		},
	})
	log.Printf("[pin] message %s unpinned in channel %s", messageID, channelID)

	return nil
}

// GetPinnedMessages, bir kanalın tüm pinlenmiş mesajlarını döner.
func (s *pinService) GetPinnedMessages(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error) {
	return s.pinRepo.GetByChannelID(ctx, channelID)
}
