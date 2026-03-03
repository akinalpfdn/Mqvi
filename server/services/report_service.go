// Package services — ReportService: kullanıcı raporlama iş mantığı.
//
// Kullanıcılar predefined reason + zorunlu açıklama ile diğer kullanıcıları raporlar.
// Validation:
// - Kendini raporlama yasak
// - Hedef kullanıcı mevcut olmalı
// - Aynı reporter→target çiftinde zaten pending rapor varsa mükerrer rapor engellenir
//
// Admin paneli ile rapor yönetimi (ListPending, UpdateStatus) ayrı service veya
// burada implement edilebilir — şimdilik CreateReport yeterli.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"

	"github.com/google/uuid"
)

// ReportService, kullanıcı raporlama işlemleri.
type ReportService interface {
	// CreateReport, yeni rapor oluşturur.
	CreateReport(ctx context.Context, reporterID, targetID string, req *models.CreateReportRequest) (*models.Report, error)
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
