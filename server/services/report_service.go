package services

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/repository"

	"github.com/google/uuid"
)

// ReportService handles user + server reporting and admin report management.
type ReportService interface {
	CreateReport(ctx context.Context, reporterID, targetID string, req *models.CreateReportRequest) (*models.Report, error)
	ListReports(ctx context.Context, status string, limit, offset int) ([]models.ReportWithUsers, int, error)
	UpdateReportStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error

	// Server reports (discovery moderation).
	CreateServerReport(ctx context.Context, reporterID, serverID string, req *models.CreateReportRequest) (*models.ServerReport, error)
	ListServerReports(ctx context.Context, status string, limit, offset int) ([]models.ServerReportWithInfo, int, error)
	UpdateServerReportStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error
}

type reportService struct {
	reportRepo       repository.ReportRepository
	serverReportRepo repository.ServerReportRepository
	userRepo         repository.UserRepository
	serverRepo       repository.ServerRepository
	urlSigner        FileURLSigner
	emailSender      email.EmailSender
}

func NewReportService(
	reportRepo repository.ReportRepository,
	serverReportRepo repository.ServerReportRepository,
	userRepo repository.UserRepository,
	serverRepo repository.ServerRepository,
	urlSigner FileURLSigner,
	emailSender email.EmailSender,
) ReportService {
	return &reportService{
		reportRepo:       reportRepo,
		serverReportRepo: serverReportRepo,
		userRepo:         userRepo,
		serverRepo:       serverRepo,
		urlSigner:        urlSigner,
		emailSender:      emailSender,
	}
}

// CreateServerReport files a user report against a public server (dedup-guarded).
func (s *reportService) CreateServerReport(ctx context.Context, reporterID, serverID string, req *models.CreateReportRequest) (*models.ServerReport, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if _, err := s.serverRepo.GetActiveByID(ctx, serverID); err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: server not found", pkg.ErrNotFound)
		}
		return nil, fmt.Errorf("failed to look up server: %w", err)
	}

	hasPending, err := s.serverReportRepo.HasPending(ctx, reporterID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to check pending server report: %w", err)
	}
	if hasPending {
		return nil, fmt.Errorf("%w: you already have a pending report for this server", pkg.ErrAlreadyExists)
	}

	report := &models.ServerReport{
		ID:          uuid.New().String(),
		ReporterID:  reporterID,
		ServerID:    serverID,
		Reason:      models.ReportReason(req.Reason),
		Description: req.Description,
		Status:      models.ReportStatusPending,
	}
	if err := s.serverReportRepo.Create(ctx, report); err != nil {
		return nil, fmt.Errorf("failed to create server report: %w", err)
	}
	return report, nil
}

func (s *reportService) ListServerReports(ctx context.Context, status string, limit, offset int) ([]models.ServerReportWithInfo, int, error) {
	reports, total, err := s.serverReportRepo.ListForAdmin(ctx, status, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list server reports: %w", err)
	}
	for i := range reports {
		atts, attErr := s.serverReportRepo.GetAttachmentsByReportID(ctx, reports[i].ID)
		if attErr != nil {
			reports[i].Attachments = []models.ServerReportAttachment{}
			continue
		}
		for j := range atts {
			atts[j].FileURL = s.urlSigner.SignURL(atts[j].FileURL)
		}
		reports[i].Attachments = atts
	}
	return reports, total, nil
}

func (s *reportService) UpdateServerReportStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error {
	return s.serverReportRepo.UpdateStatus(ctx, reportID, status, adminID)
}

func (s *reportService) CreateReport(ctx context.Context, reporterID, targetID string, req *models.CreateReportRequest) (*models.Report, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if reporterID == targetID {
		return nil, fmt.Errorf("%w: cannot report yourself", pkg.ErrBadRequest)
	}

	// Reports target active users only — deleted users can't be re-reported
	// (existing reports on now-deleted users still exist for audit).
	if _, err := s.userRepo.GetActiveByID(ctx, targetID); err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
		}
		return nil, fmt.Errorf("failed to look up user: %w", err)
	}

	// Duplicate check — prevent multiple pending reports for the same pair
	hasPending, err := s.reportRepo.HasPendingReport(ctx, reporterID, targetID)
	if err != nil {
		return nil, fmt.Errorf("failed to check pending report: %w", err)
	}
	if hasPending {
		return nil, fmt.Errorf("%w: you already have a pending report for this user", pkg.ErrAlreadyExists)
	}

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

	s.notifyAdmins(report)

	return report, nil
}

// notifyAdmins emails platform admins about the new report in a detached
// goroutine — failures must never affect the user-facing response.
func (s *reportService) notifyAdmins(report *models.Report) {
	if s.emailSender == nil || s.userRepo == nil {
		return
	}
	go func() {
		bg := context.Background()
		reporter, err := s.userRepo.GetByID(bg, report.ReporterID)
		if err != nil {
			log.Printf("[report] lookup reporter %s: %v", report.ReporterID, err)
			return
		}
		reported, err := s.userRepo.GetByID(bg, report.ReportedUserID)
		if err != nil {
			log.Printf("[report] lookup reported %s: %v", report.ReportedUserID, err)
			return
		}
		emails, err := s.userRepo.ListPlatformAdminEmails(bg)
		if err != nil {
			log.Printf("[report] list admin emails: %v", err)
			return
		}
		for _, addr := range emails {
			if err := s.emailSender.SendNewReportNotification(bg, addr, reporter.Username, reported.Username, string(report.Reason)); err != nil {
				log.Printf("[report] notify admin %s: %v", addr, err)
			}
		}
	}()
}

// ListReports returns reports with attachments. Filters by status if provided.
// N+1 query for attachments — acceptable since admin panel has limited report count (max 100).
func (s *reportService) ListReports(ctx context.Context, status string, limit, offset int) ([]models.ReportWithUsers, int, error) {
	var reports []models.ReportWithUsers
	var total int
	var err error

	if status == string(models.ReportStatusPending) {
		reports, total, err = s.reportRepo.ListPending(ctx, limit, offset)
	} else {
		reports, total, err = s.reportRepo.ListAll(ctx, limit, offset)
	}

	if err != nil {
		return nil, 0, fmt.Errorf("failed to list reports: %w", err)
	}

	// Populate attachments for each report
	for i := range reports {
		attachments, attErr := s.reportRepo.GetAttachmentsByReportID(ctx, reports[i].ID)
		if attErr != nil {
			reports[i].Attachments = []models.ReportAttachment{}
			continue
		}
		for j := range attachments {
			attachments[j].FileURL = s.urlSigner.SignURL(attachments[j].FileURL)
		}
		reports[i].Attachments = attachments
	}

	return reports, total, nil
}

func (s *reportService) UpdateReportStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error {
	if err := s.reportRepo.UpdateStatus(ctx, reportID, status, adminID); err != nil {
		return fmt.Errorf("failed to update report status: %w", err)
	}
	return nil
}
