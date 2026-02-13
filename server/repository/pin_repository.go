package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// PinRepository, mesaj sabitleme veritabanı işlemleri için interface.
//
// GetByChannelID: Bir kanalın tüm pinlenmiş mesajlarını döner (en yeni pin üstte).
// Pin: Bir mesajı sabitler — aynı mesaj zaten pinliyse hata döner.
// Unpin: Bir mesajın pin'ini kaldırır.
// IsPinned: Bir mesajın pinli olup olmadığını kontrol eder.
// CountByChannelID: Bir kanaldaki pin sayısını döner (limit kontrolü için).
type PinRepository interface {
	GetByChannelID(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error)
	Pin(ctx context.Context, pin *models.PinnedMessage) error
	Unpin(ctx context.Context, messageID string) error
	IsPinned(ctx context.Context, messageID string) (bool, error)
	CountByChannelID(ctx context.Context, channelID string) (int, error)
}
