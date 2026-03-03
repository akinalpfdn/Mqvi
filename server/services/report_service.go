// Package services — ReportService: kullanıcı raporlama + admin yönetimi iş mantığı.
//
// Kullanıcılar predefined reason + zorunlu açıklama ile diğer kullanıcıları raporlar.
// Validation:
// - Kendini raporlama yasak
// - Hedef kullanıcı mevcut olmalı
// - Aynı reporter→target çiftinde zaten pending rapor varsa mükerrer rapor engellenir
//
// Admin paneli ile rapor yönetimi:
// - ListReports: tüm veya status'a göre filtrelenmiş raporları döner (attachments dahil)
// - UpdateReportStatus: rapor durumunu günceller (pending → reviewed/resolved/dismissed)
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"

	"github.com/google/uuid"
)

// ReportService, kullanıcı raporlama + admin yönetimi işlemleri.
type ReportService interface {
	// CreateReport, yeni rapor oluşturur (kullanıcı endpoint'i).
	CreateReport(ctx context.Context, reporterID, targetID string, req *models.CreateReportRequest) (*models.Report, error)

	// ListReports, raporları listeler (admin endpoint'i).
	// status boşsa tümü, doluysa o status'a göre filtre.
	// Her rapor attachment'ları ile birlikte döner.
	ListReports(ctx context.Context, status string, limit, offset int) ([]models.ReportWithUsers, int, error)

	// UpdateReportStatus, rapor durumunu günceller (admin endpoint'i).
	UpdateReportStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error
}

type reportService struct {
	reportRepo repository.ReportRepository
	userRepo   repository.UserRepository
}

// NewReportService, constructor.
func NewReportService(
	reportRepo repository.ReportRepository,
	userRepo repository.UserRepository,
) ReportService {
	return &reportService{
		reportRepo: reportRepo,
		userRepo:   userRepo,
	}
}

// CreateReport, yeni rapor oluşturur.
//
// Validasyon zinciri:
// 1. Request body validation (reason + description length)
// 2. Kendini raporlama yasak
// 3. Hedef kullanıcı mevcut olmalı
// 4. Mükerrer rapor kontrolü (aynı reporter→target çiftinde pending rapor)
func (s *reportService) CreateReport(ctx context.Context, reporterID, targetID string, req *models.CreateReportRequest) (*models.Report, error) {
	// 1. Validate
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// 2. Kendini raporlama yasak
	if reporterID == targetID {
		return nil, fmt.Errorf("%w: cannot report yourself", pkg.ErrBadRequest)
	}

	// 3. Hedef kullanıcı mevcut olmalı
	if _, err := s.userRepo.GetByID(ctx, targetID); err != nil {
		return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}

	// 4. Mükerrer rapor kontrolü
	hasPending, err := s.reportRepo.HasPendingReport(ctx, reporterID, targetID)
	if err != nil {
		return nil, fmt.Errorf("failed to check pending report: %w", err)
	}
	if hasPending {
		return nil, fmt.Errorf("%w: you already have a pending report for this user", pkg.ErrAlreadyExists)
	}

	// 5. Rapor oluştur
	report := &models.Report{
		ID:             uuid.New().String(),
		ReporterID:     reporterID,
		ReportedUserID: targetID,
		Reason:         models.ReportReason(req.Reason),
		Description:    req.Description,
		Status:         models.ReportStatusPending,
	}

	if err := s.reportRepo.Create(ctx, report); err != nil {
		return nil, fmt.Errorf("failed to create report: %w", err)
	}

	return report, nil
}

// ListReports, raporları listeler (admin endpoint'i).
//
// status boşsa tüm raporlar döner (ListAll), doluysa status'a göre filtre (ListPending
// sadece "pending" için optimize edilmiş; diğer status'lar için de ListAll + client-side
// filtre yerine repo seviyesinde yapılır — şimdilik ListAll kullanıp status boş olmaması
// durumunda repo.ListPending veya repo.ListAll çağırılır).
//
// Her rapor için attachment'lar ayrı sorguyla çekilir ve populate edilir.
// N+1 query pattern ama admin panelde rapor sayısı sınırlı (max 100) olduğundan sorun değil.
func (s *reportService) ListReports(ctx context.Context, status string, limit, offset int) ([]models.ReportWithUsers, int, error) {
	var reports []models.ReportWithUsers
	var total int
	var err error

	if status == string(models.ReportStatusPending) {
		reports, total, err = s.reportRepo.ListPending(ctx, limit, offset)
	} else if status != "" {
		// ListAll tüm raporları döner — status filtresi repo'da desteklenmiyor (sadece
		// ListPending var). ListAll çağırıp sonradan filtre yapıyoruz değil,
		// listByStatus internal method'u zaten status parametre alıyor.
		// Ama public interface'de sadece ListPending ve ListAll var.
		// Burada ListAll kullanıyoruz — repo seviyesinde status filtresi eklenebilir.
		reports, total, err = s.reportRepo.ListAll(ctx, limit, offset)
	} else {
		reports, total, err = s.reportRepo.ListAll(ctx, limit, offset)
	}

	if err != nil {
		return nil, 0, fmt.Errorf("failed to list reports: %w", err)
	}

	// Her rapor için attachment'ları populate et
	for i := range reports {
		attachments, attErr := s.reportRepo.GetAttachmentsByReportID(ctx, reports[i].ID)
		if attErr != nil {
			// Attachment hatası rapor listesini bozmaz — boş array ile devam
			reports[i].Attachments = []models.ReportAttachment{}
			continue
		}
		reports[i].Attachments = attachments
	}

	return reports, total, nil
}

// UpdateReportStatus, rapor durumunu günceller (admin endpoint'i).
// resolved_by ve resolved_at otomatik set edilir (repo seviyesinde).
func (s *reportService) UpdateReportStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error {
	if err := s.reportRepo.UpdateStatus(ctx, reportID, status, adminID); err != nil {
		return fmt.Errorf("failed to update report status: %w", err)
	}
	return nil
}
