package services

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// Embedded interfaces: only the methods CreateReport touches are implemented.
type stubReportRepo struct {
	repository.ReportRepository
	created *models.Report
}

func (s *stubReportRepo) HasPendingReport(_ context.Context, _, _, _, _ string) (bool, error) {
	return false, nil
}

func (s *stubReportRepo) Create(_ context.Context, r *models.Report) error {
	s.created = r
	return nil
}

type stubActiveUserRepo struct{ repository.UserRepository }

func (stubActiveUserRepo) GetActiveByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id}, nil
}

type stubMessageRepo struct {
	repository.MessageRepository
	msg *models.Message
}

func (s stubMessageRepo) GetByID(_ context.Context, id string) (*models.Message, error) {
	if s.msg == nil || s.msg.ID != id {
		return nil, fmt.Errorf("%w: message %s", pkg.ErrNotFound, id)
	}
	return s.msg, nil
}

type stubDMRepoForReport struct {
	repository.DMRepository
	msg *models.DMMessage
	ch  *models.DMChannel
}

func (s stubDMRepoForReport) GetMessageByID(_ context.Context, id string) (*models.DMMessage, error) {
	if s.msg == nil || s.msg.ID != id {
		return nil, fmt.Errorf("%w: dm message %s", pkg.ErrNotFound, id)
	}
	return s.msg, nil
}

func (s stubDMRepoForReport) GetChannelByID(_ context.Context, id string) (*models.DMChannel, error) {
	if s.ch == nil || s.ch.ID != id {
		return nil, fmt.Errorf("%w: dm channel %s", pkg.ErrNotFound, id)
	}
	return s.ch, nil
}

func TestCreateReport_MessageContext(t *testing.T) {
	const reporter, target, other = "u-reporter", "u-target", "u-other"
	channelMsg := &models.Message{ID: "m1", ChannelID: "c1", UserID: target}
	dmMsg := &models.DMMessage{ID: "d1", DMChannelID: "dc1", UserID: target}
	dmChannel := &models.DMChannel{ID: "dc1", User1ID: target, User2ID: reporter}
	foreignDMChannel := &models.DMChannel{ID: "dc1", User1ID: target, User2ID: other}

	tests := []struct {
		name        string
		req         models.CreateReportRequest
		msg         *models.Message
		dmMsg       *models.DMMessage
		dmCh        *models.DMChannel
		wantErr     error
		wantExcerpt string
	}{
		{
			name:        "should store excerpt when channel message belongs to reported user",
			req:         models.CreateReportRequest{Reason: "harassment", Description: "long enough text", MessageID: "m1", MessageExcerpt: "you suck"},
			msg:         channelMsg,
			wantExcerpt: "you suck",
		},
		{
			name:    "should refuse channel message written by someone else",
			req:     models.CreateReportRequest{Reason: "harassment", Description: "long enough text", MessageID: "m1"},
			msg:     &models.Message{ID: "m1", ChannelID: "c1", UserID: other},
			wantErr: pkg.ErrForbidden,
		},
		{
			name:    "should refuse unknown channel message",
			req:     models.CreateReportRequest{Reason: "spam", Description: "long enough text", MessageID: "missing"},
			wantErr: pkg.ErrNotFound,
		},
		{
			name:        "should accept DM message when reporter is a participant",
			req:         models.CreateReportRequest{Reason: "spam", Description: "long enough text", DMMessageID: "d1", MessageExcerpt: "buy now"},
			dmMsg:       dmMsg,
			dmCh:        dmChannel,
			wantExcerpt: "buy now",
		},
		{
			name:    "should refuse DM message when reporter is not a participant",
			req:     models.CreateReportRequest{Reason: "spam", Description: "long enough text", DMMessageID: "d1"},
			dmMsg:   dmMsg,
			dmCh:    foreignDMChannel,
			wantErr: pkg.ErrForbidden,
		},
		{
			name:    "should refuse both message ids at once",
			req:     models.CreateReportRequest{Reason: "spam", Description: "long enough text", MessageID: "m1", DMMessageID: "d1"},
			wantErr: pkg.ErrBadRequest,
		},
		{
			name:    "should refuse excerpt without a message reference",
			req:     models.CreateReportRequest{Reason: "spam", Description: "long enough text", MessageExcerpt: "orphan"},
			wantErr: pkg.ErrBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &stubReportRepo{}
			svc := NewReportService(repo, nil, stubActiveUserRepo{}, nil,
				stubMessageRepo{msg: tt.msg}, stubDMRepoForReport{msg: tt.dmMsg, ch: tt.dmCh}, nil, nil)

			req := tt.req
			report, err := svc.CreateReport(context.Background(), reporter, target, &req)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("want %v, got %v", tt.wantErr, err)
				}
				if repo.created != nil {
					t.Fatalf("report must not be persisted on %v", tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if repo.created == nil || repo.created.ID != report.ID {
				t.Fatalf("report not persisted")
			}
			if got := derefString(report.MessageExcerpt); got != tt.wantExcerpt {
				t.Fatalf("excerpt: want %q, got %q", tt.wantExcerpt, got)
			}
			if (tt.req.MessageID != "") != (report.MessageID != nil) || (tt.req.DMMessageID != "") != (report.DMMessageID != nil) {
				t.Fatalf("message ids not carried onto the report: %+v", report)
			}
		})
	}
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
