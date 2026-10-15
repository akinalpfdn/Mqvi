package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// Consumer-side interfaces: moderation only deletes, so it does not depend on the
// full message / DM / voice service surfaces.
type ModeratedMessageDeleter interface {
	DeleteAsModerator(ctx context.Context, id string) error
}

type ModeratedDMMessageDeleter interface {
	DeleteMessageAsModerator(ctx context.Context, id string) error
}

type ModeratedVoiceMessageDeleter interface {
	DeleteAsModerator(ctx context.Context, id string) error
}

// ReportModerationService acts on a report from the admin panel.
type ReportModerationService interface {
	// DeleteReportedMessage removes the message the report points at (channel, DM or
	// voice) and resolves the report. A message that is already gone still resolves:
	// the report's excerpt is the evidence.
	DeleteReportedMessage(ctx context.Context, reportID, adminID string) error
}

type reportModerationService struct {
	reportRepo repository.ReportRepository
	messages   ModeratedMessageDeleter
	dms        ModeratedDMMessageDeleter
	voice      ModeratedVoiceMessageDeleter
}

func NewReportModerationService(
	reportRepo repository.ReportRepository,
	messages ModeratedMessageDeleter,
	dms ModeratedDMMessageDeleter,
	voice ModeratedVoiceMessageDeleter,
) ReportModerationService {
	return &reportModerationService{reportRepo: reportRepo, messages: messages, dms: dms, voice: voice}
}

func (s *reportModerationService) DeleteReportedMessage(ctx context.Context, reportID, adminID string) error {
	report, err := s.reportRepo.GetByID(ctx, reportID)
	if err != nil {
		return err
	}

	var delErr error
	switch {
	case report.MessageID != nil:
		delErr = s.messages.DeleteAsModerator(ctx, *report.MessageID)
	case report.DMMessageID != nil:
		delErr = s.dms.DeleteMessageAsModerator(ctx, *report.DMMessageID)
	case report.VoiceMessageID != nil:
		delErr = s.voice.DeleteAsModerator(ctx, *report.VoiceMessageID)
	default:
		return fmt.Errorf("%w: report does not reference a message", pkg.ErrBadRequest)
	}
	if delErr != nil && !errors.Is(delErr, pkg.ErrNotFound) {
		return fmt.Errorf("delete reported message for report %s: %w", reportID, delErr)
	}

	if err := s.reportRepo.UpdateStatus(ctx, reportID, models.ReportStatusResolved, adminID); err != nil {
		return fmt.Errorf("resolve report %s: %w", reportID, err)
	}
	return nil
}
