// Package repository — ReportRepository interface.
//
// Kullanıcı raporlama sistemi CRUD soyutlaması.
// Admin panelinden raporlar listelenip yönetilir.
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ReportRepository, rapor veritabanı işlemleri.
type ReportRepository interface {
	// Create, yeni rapor oluşturur.
	Create(ctx context.Context, report *models.Report) error

	// GetByID, ID ile rapor döner.
	GetByID(ctx context.Context, id string) (*models.Report, error)

	// ListPending, bekleyen raporları sayfalanmış döner.
	// Admin paneli kullanır. totalCount ile toplam kayıt sayısı da döner.
	ListPending(ctx context.Context, limit, offset int) ([]models.ReportWithUsers, int, error)

	// ListAll, tüm raporları (tüm status) sayfalanmış döner.
	ListAll(ctx context.Context, limit, offset int) ([]models.ReportWithUsers, int, error)

	// UpdateStatus, rapor durumunu günceller (pending → reviewed/resolved/dismissed).
	UpdateStatus(ctx context.Context, id string, status models.ReportStatus, resolvedBy string) error

	// HasPendingReport, reporter→target çiftinde aktif (pending) rapor var mı kontrol eder.
	HasPendingReport(ctx context.Context, reporterID, targetID string) (bool, error)
}
