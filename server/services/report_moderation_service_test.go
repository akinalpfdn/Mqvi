package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

type stubModerationReportRepo struct {
	repository.ReportRepository
	report   *models.Report
	resolved bool
}

func (s *stubModerationReportRepo) GetByID(_ context.Context, id string) (*models.Report, error) {
	if s.report == nil || s.report.ID != id {
		return nil, pkg.ErrNotFound
	}
	return s.report, nil
}

func (s *stubModerationReportRepo) UpdateStatus(_ context.Context, _ string, status models.ReportStatus, _ string) error {
	s.resolved = status == models.ReportStatusResolved
	return nil
}

type deleterSpy struct {
	deleted []string
	err     error
}

func (d *deleterSpy) DeleteAsModerator(_ context.Context, id string) error {
	d.deleted = append(d.deleted, id)
	return d.err
}

func (d *deleterSpy) DeleteMessageAsModerator(_ context.Context, id string) error {
	return d.DeleteAsModerator(context.Background(), id)
}

func TestDeleteReportedMessage(t *testing.T) {
	id := func(s string) *string { return &s }
	tests := []struct {
		name         string
		report       *models.Report
		deleteErr    error
		wantErr      error
		wantDeleted  string // which spy should have been called: msg | dm | voice | ""
		wantResolved bool
	}{
		{"should delete a channel message and resolve", &models.Report{ID: "r1", MessageID: id("m1")}, nil, nil, "msg", true},
		{"should delete a DM message and resolve", &models.Report{ID: "r1", DMMessageID: id("d1")}, nil, nil, "dm", true},
		{"should delete a voice message and resolve", &models.Report{ID: "r1", VoiceMessageID: id("v1")}, nil, nil, "voice", true},
		{"should still resolve when the message is already gone", &models.Report{ID: "r1", MessageID: id("m1")}, pkg.ErrNotFound, nil, "msg", true},
		{"should not resolve when the delete fails for another reason", &models.Report{ID: "r1", MessageID: id("m1")}, errors.New("disk"), errors.New("disk"), "msg", false},
		{"should reject a report without a message reference", &models.Report{ID: "r1"}, nil, pkg.ErrBadRequest, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &stubModerationReportRepo{report: tt.report}
			msg, dm, voice := &deleterSpy{err: tt.deleteErr}, &deleterSpy{err: tt.deleteErr}, &deleterSpy{err: tt.deleteErr}
			svc := NewReportModerationService(repo, msg, dm, voice)

			err := svc.DeleteReportedMessage(context.Background(), "r1", "admin")

			if tt.wantErr != nil {
				if err == nil || (errors.Is(tt.wantErr, pkg.ErrBadRequest) && !errors.Is(err, pkg.ErrBadRequest)) {
					t.Fatalf("want error %v, got %v", tt.wantErr, err)
				}
			} else if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			called := map[string]*deleterSpy{"msg": msg, "dm": dm, "voice": voice}
			for k, spy := range called {
				if (k == tt.wantDeleted) != (len(spy.deleted) == 1) {
					t.Fatalf("deleter %s called=%v, want called=%v", k, len(spy.deleted) == 1, k == tt.wantDeleted)
				}
			}
			if repo.resolved != tt.wantResolved {
				t.Fatalf("resolved=%v, want %v", repo.resolved, tt.wantResolved)
			}
		})
	}
}
