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

	// Delete, bir LiveKit instance kaydını siler.
	Delete(ctx context.Context, id string) error
}
