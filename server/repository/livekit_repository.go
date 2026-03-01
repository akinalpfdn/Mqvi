// Package repository — LiveKitRepository interface.
//
// LiveKit instance CRUD + sunucu mapping soyutlaması.
// Her sunucu bir LiveKit SFU instance'ına bağlıdır.
// Platform-managed instance'lar: mqvi hosted sunucular için otomatik atanır.
// Self-hosted instance'lar: kullanıcının kendi LiveKit sunucusu.
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// LiveKitRepository, LiveKit instance veritabanı işlemleri için interface.
type LiveKitRepository interface {
	// Create, yeni bir LiveKit instance kaydı oluşturur.
	Create(ctx context.Context, instance *models.LiveKitInstance) error

	// GetByID, ID ile LiveKit instance döner.
	GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error)

	// GetByServerID, sunucuya bağlı LiveKit instance'ı döner.
	// servers tablosundaki livekit_instance_id üzerinden JOIN yapar.
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)

	// GetLeastLoadedPlatformInstance, en az sunucu bağlı platform-managed instance'ı döner.
	// Yeni mqvi hosted sunucu oluşturulurken kullanılır — load balancing.
	GetLeastLoadedPlatformInstance(ctx context.Context) (*models.LiveKitInstance, error)

	// IncrementServerCount, bir instance'ın bağlı sunucu sayısını 1 artırır.
	IncrementServerCount(ctx context.Context, instanceID string) error

	// DecrementServerCount, bir instance'ın bağlı sunucu sayısını 1 azaltır.
	DecrementServerCount(ctx context.Context, instanceID string) error

	// Update, mevcut bir LiveKit instance'ın URL ve credential'larını günceller.
	// Self-hosted sunucularda owner'ın bağlantı bilgilerini değiştirmesi için kullanılır.
	Update(ctx context.Context, instance *models.LiveKitInstance) error

	// Delete, bir LiveKit instance kaydını siler.
	Delete(ctx context.Context, id string) error

	// ListPlatformInstances, tüm platform-managed LiveKit instance'larını döner.
	// Admin panelde liste görünümü için kullanılır.
	ListPlatformInstances(ctx context.Context) ([]models.LiveKitInstance, error)

	// MigrateServers, bir instance'daki tüm sunucuları başka bir instance'a taşır.
	// Instance silme öncesi çağrılır. Taşınan sunucu sayısını döner.
	// Transaction içinde çalışır: server_count güncelleme + servers.livekit_instance_id güncelleme.
	MigrateServers(ctx context.Context, fromInstanceID, toInstanceID string) (int64, error)

	// MigrateOneServer, tek bir sunucunun LiveKit instance'ını değiştirir.
	// Transaction içinde: eski instance server_count--, yeni instance server_count++,
	// servers.livekit_instance_id güncelle.
	MigrateOneServer(ctx context.Context, serverID, newInstanceID string) error
}
