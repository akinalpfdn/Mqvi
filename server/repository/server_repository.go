// Package repository — ServerRepository interface.
//
// Çoklu sunucu CRUD + üyelik yönetimi soyutlaması.
// Her kullanıcı birden fazla sunucuya üye olabilir.
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ServerRepository, sunucu veritabanı işlemleri için interface.
type ServerRepository interface {
	// ─── Server CRUD ───

	// Create, yeni bir sunucu oluşturur.
	Create(ctx context.Context, server *models.Server) error

	// GetByID, ID ile sunucu döner.
	GetByID(ctx context.Context, serverID string) (*models.Server, error)

	// Update, sunucu bilgisini günceller.
	Update(ctx context.Context, server *models.Server) error

	// Delete, bir sunucuyu siler. CASCADE ile tüm bağlı veriler silinir.
	Delete(ctx context.Context, serverID string) error

	// ─── Üyelik ───

	// GetUserServers, kullanıcının üye olduğu sunucuların listesini döner.
	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)

	// AddMember, kullanıcıyı sunucuya üye yapar.
	AddMember(ctx context.Context, serverID, userID string) error

	// RemoveMember, kullanıcıyı sunucudan çıkarır.
	RemoveMember(ctx context.Context, serverID, userID string) error

	// IsMember, kullanıcının sunucu üyesi olup olmadığını kontrol eder.
	IsMember(ctx context.Context, serverID, userID string) (bool, error)

	// GetMemberCount, sunucunun üye sayısını döner.
	GetMemberCount(ctx context.Context, serverID string) (int, error)

	// GetMemberServerIDs, kullanıcının üye olduğu tüm sunucu ID'lerini döner.
	// WebSocket hub'da client.ServerIDs doldurmak için kullanılır.
	GetMemberServerIDs(ctx context.Context, userID string) ([]string, error)

	// UpdateMemberPositions, bir kullanıcının sunucu sıralamasını günceller.
	// Per-user: sadece o kullanıcının server_members.position değerlerini değiştirir.
	// Transaction içinde çalışır — ya hepsi güncellenir ya hiçbiri.
	UpdateMemberPositions(ctx context.Context, userID string, items []models.PositionUpdate) error

	// GetMaxMemberPosition, bir kullanıcının en yüksek position değerini döner.
	// Yeni sunucuya katılırken position = max+1 atamak için kullanılır.
	GetMaxMemberPosition(ctx context.Context, userID string) (int, error)

	// ─── Admin ───

	// ListAllWithStats, platformdaki tüm sunucuları istatistikleriyle birlikte döner.
	// Platform admin panelde sunucu listesi için kullanılır.
	// Tek SQL sorgusu ile member_count, channel_count, message_count,
	// storage_mb ve last_activity hesaplanır.
	ListAllWithStats(ctx context.Context) ([]models.AdminServerListItem, error)

	// UpdateLastVoiceActivity, bir sunucunun son ses aktivitesi zamanını günceller.
	// Ses kanalına katılım olduğunda çağrılır (hub callback'ten).
	UpdateLastVoiceActivity(ctx context.Context, serverID string) error

	// CountOwnedMqviHostedServers, bir kullanıcının owner olduğu
	// mqvi-hosted (platform-managed) sunucu sayısını döner.
	// Sunucu oluşturma limiti kontrolünde kullanılır.
	CountOwnedMqviHostedServers(ctx context.Context, ownerID string) (int, error)
}
