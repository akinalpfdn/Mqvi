// Package repository — FriendshipRepository interface.
//
// Arkadaşlık sistemi için CRUD soyutlaması.
// Interface Segregation: FriendshipRepository sadece arkadaşlık işlemlerini kapsar.
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// FriendshipRepository, arkadaşlık veritabanı işlemleri için interface.
//
// Sorgu mantığı:
// - "Accepted" arkadaşlar: user_id = me OR friend_id = me (çift yönlü)
// - "Pending" gelen istekler: friend_id = me AND status = 'pending'
// - "Pending" giden istekler: user_id = me AND status = 'pending'
type FriendshipRepository interface {
	// Create, yeni bir arkadaşlık kaydı oluşturur (status = pending).
	Create(ctx context.Context, friendship *models.Friendship) error

	// GetByID, ID ile bir arkadaşlık kaydı döner.
	// Bulunamazsa pkg.ErrNotFound döner.
	GetByID(ctx context.Context, id string) (*models.Friendship, error)

	// GetByPair, iki kullanıcı arasındaki kaydı döner (yön fark etmez).
	// A→B veya B→A kaydı varsa onu döner. Bulunamazsa pkg.ErrNotFound.
	GetByPair(ctx context.Context, userID, friendID string) (*models.Friendship, error)

	// ListFriends, kullanıcının kabul edilmiş arkadaşlarını kullanıcı bilgisiyle döner.
	// Çift yönlü sorgu: user_id = me OR friend_id = me (status = 'accepted')
	ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	// ListIncoming, kullanıcıya gelen bekleyen istekleri döner.
	// friend_id = me AND status = 'pending'
	ListIncoming(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	// ListOutgoing, kullanıcının gönderdiği bekleyen istekleri döner.
	// user_id = me AND status = 'pending'
	ListOutgoing(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	// UpdateStatus, bir arkadaşlık kaydının durumunu günceller.
	// pending → accepted (kabul), pending → delete (reddet).
	UpdateStatus(ctx context.Context, id string, status models.FriendshipStatus) error

	// Delete, bir arkadaşlık kaydını siler.
	// Arkadaşlıktan çıkarma veya istek reddetme için kullanılır.
	Delete(ctx context.Context, id string) error

	// DeleteByPair, iki kullanıcı arasındaki kaydı siler (yön fark etmez).
	DeleteByPair(ctx context.Context, userID, friendID string) error
}
