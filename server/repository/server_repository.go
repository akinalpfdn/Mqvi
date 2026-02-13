// Package repository — ServerRepository interface.
//
// Sunucu verisi için CRUD soyutlaması.
// Tek sunucu mimarisi olduğu için Get/Update yeterlidir —
// Create/Delete gerekmez (sunucu seed migration ile oluşturulur).
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ServerRepository, sunucu veritabanı işlemleri için interface.
type ServerRepository interface {
	// Get, sunucu bilgisini döner. Tek sunucu olduğu için ID gerekmez.
	Get(ctx context.Context) (*models.Server, error)

	// Update, sunucu bilgisini günceller.
	Update(ctx context.Context, server *models.Server) error
}
