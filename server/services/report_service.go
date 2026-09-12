package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"

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
	messageRepo      repository.MessageRepository
	dmRepo           repository.DMRepository
	voiceMsgRepo     repository.VoiceMessageRepository
	permResolver     ChannelPermResolver
	voiceMembership  VoiceChannelMembershipChecker
	urlSigner        FileURLSigner
	emailSender      email.EmailSender
}

func NewReportService(
	reportRepo repository.ReportRepository,
	serverReportRepo repository.ServerReportRepository,
	userRepo repository.UserRepository,
	serverRepo repository.ServerRepository,
	messageRepo repository.MessageRepository,
	dmRepo repository.DMRepository,
	voiceMsgRepo repository.VoiceMessageRepository,
	permResolver ChannelPermResolver,
	voiceMembership VoiceChannelMembershipChecker,
	urlSigner FileURLSigner,
	emailSender email.EmailSender,
) ReportService {
	return &reportService{
		reportRepo:       reportRepo,
		serverReportRepo: serverReportRepo,
		userRepo:         userRepo,
		serverRepo:       serverRepo,
		messageRepo:      messageRepo,
		dmRepo:           dmRepo,
		voiceMsgRepo:     voiceMsgRepo,
		permResolver:     permResolver,
		voiceMembership:  voiceMembership,
		urlSigner:        urlSigner,
		emailSender:      emailSender,
	}
}

// CreateServerReport files a user report against a public server (dedup-guarded).
func (s *reportService) CreateServerReport(ctx context.Context, reporterID, serverID string, req *models.CreateReportRequest) (*models.ServerReport, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	srv, err := s.serverRepo.GetActiveByID(ctx, serverID)
	if err != nil {
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

	s.notifyAdminsServerReport(report, srv.Name)

	return report, nil
}

// notifyAdminsServerReport mirrors notifyAdmins for discovery server reports.
func (s *reportService) notifyAdminsServerReport(report *models.ServerReport, serverName string) {
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
		emails, err := s.userRepo.ListPlatformAdminEmails(bg)
		if err != nil {
			log.Printf("[report] list admin emails: %v", err)
			return
		}
		for _, addr := range emails {
			if err := s.emailSender.SendNewServerReportNotification(bg, addr, reporter.Username, serverName, string(report.Reason)); err != nil {
				log.Printf("[report] notify admin %s (server report): %v", addr, err)
			}
		}
	}()
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

	excerptSource, err := s.resolveMessageContext(ctx, reporterID, targetID, req)
	if err != nil {
		return nil, err
	}

	// Duplicate check — one pending report per (reporter, target, message context)
	hasPending, err := s.reportRepo.HasPendingReport(ctx, reporterID, targetID, req.MessageID, req.DMMessageID, req.VoiceMessageID)
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
		MessageID:      nilIfEmpty(req.MessageID),
		DMMessageID:    nilIfEmpty(req.DMMessageID),
		VoiceMessageID: nilIfEmpty(req.VoiceMessageID),
		MessageExcerpt: nilIfEmpty(req.MessageExcerpt),
		ExcerptSource:  nilIfEmpty(excerptSource),
	}

	if err := s.reportRepo.Create(ctx, report); err != nil {
		return nil, fmt.Errorf("failed to create report: %w", err)
	}

	s.notifyAdmins(report)

	return report, nil
}

// resolveMessageContext verifies the referenced message (exists, written by the
// reported user, reporter may see it) and fixes the excerpt that will outlive it.
// Plaintext content is snapshotted server-side and the reporter's text discarded;
// E2EE content is opaque here, so the reporter's excerpt is kept and labelled.
func (s *reportService) resolveMessageContext(ctx context.Context, reporterID, targetID string, req *models.CreateReportRequest) (string, error) {
	switch {
	case req.MessageID != "":
		msg, err := s.messageRepo.GetByID(ctx, req.MessageID)
		if err != nil {
			return "", messageLookupError("message", err)
		}
		if msg.UserID != targetID {
			return "", fmt.Errorf("%w: message was not written by the reported user", pkg.ErrForbidden)
		}
		// The response echoes the server snapshot, so this is a read of the channel:
		// gate it exactly like GetByChannelID.
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, reporterID, msg.ChannelID)
		if err != nil {
			return "", fmt.Errorf("failed to resolve channel permissions: %w", err)
		}
		if !perms.Has(models.PermReadMessages) {
			return "", fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
		}
		if msg.EncryptionVersion != 0 {
			return clientExcerpt(req), nil
		}
		return serverExcerpt(req, msg.Content), nil

	case req.DMMessageID != "":
		msg, err := s.dmRepo.GetMessageByID(ctx, req.DMMessageID)
		if err != nil {
			return "", messageLookupError("DM message", err)
		}
		if msg.UserID != targetID {
			return "", fmt.Errorf("%w: message was not written by the reported user", pkg.ErrForbidden)
		}
		ch, err := s.dmRepo.GetChannelByID(ctx, msg.DMChannelID)
		if err != nil {
			return "", fmt.Errorf("failed to look up DM channel: %w", err)
		}
		if ch.User1ID != reporterID && ch.User2ID != reporterID {
			return "", fmt.Errorf("%w: not a participant of this conversation", pkg.ErrForbidden)
		}
		if msg.EncryptionVersion != 0 {
			return clientExcerpt(req), nil
		}
		return serverExcerpt(req, msg.Content), nil

	case req.VoiceMessageID != "":
		// Voice chat is wiped when the session ends; the snapshot is the only copy that survives.
		msg, err := s.voiceMsgRepo.GetByID(ctx, req.VoiceMessageID)
		if err != nil {
			return "", messageLookupError("voice message", err)
		}
		if msg.UserID != targetID {
			return "", fmt.Errorf("%w: message was not written by the reported user", pkg.ErrForbidden)
		}
		// Voice chat is visible to current participants only; same gate as List.
		state := s.voiceMembership.GetUserVoiceState(reporterID)
		if state == nil || state.ChannelID != msg.ChannelID {
			return "", fmt.Errorf("%w: not currently in voice channel", pkg.ErrForbidden)
		}
		return serverExcerpt(req, msg.Content), nil
	}
	return "", nil
}

func messageLookupError(kind string, err error) error {
	if errors.Is(err, pkg.ErrNotFound) {
		return fmt.Errorf("%w: %s not found", pkg.ErrNotFound, kind)
	}
	return fmt.Errorf("failed to look up %s: %w", kind, err)
}

// serverExcerpt replaces whatever the client sent with the stored text.
func serverExcerpt(req *models.CreateReportRequest, content *string) string {
	req.MessageExcerpt = ""
	if content != nil {
		req.MessageExcerpt = truncateRunes(strings.TrimSpace(*content), models.MaxReportExcerptLength)
	}
	return models.ExcerptSourceServer
}

func clientExcerpt(req *models.CreateReportRequest) string {
	if req.MessageExcerpt == "" {
		return ""
	}
	return models.ExcerptSourceClient
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
