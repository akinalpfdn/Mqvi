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

func (s *stubReportRepo) HasPendingReport(_ context.Context, _, _, _, _, _ string) (bool, error) {
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

type stubVoiceMessageRepo struct {
	repository.VoiceMessageRepository
	msg *models.VoiceMessage
}

func (s stubVoiceMessageRepo) GetByID(_ context.Context, id string) (*models.VoiceMessage, error) {
	if s.msg == nil || s.msg.ID != id {
		return nil, pkg.ErrNotFound
	}
	return s.msg, nil
}

func strPtr(s string) *string { return &s }

func TestCreateReport_MessageContext(t *testing.T) {
	const reporter, target, other = "u-reporter", "u-target", "u-other"
	plainChannelMsg := &models.Message{ID: "m1", ChannelID: "c1", UserID: target, Content: strPtr("you suck")}
	e2eeChannelMsg := &models.Message{ID: "m2", ChannelID: "c1", UserID: target, EncryptionVersion: 1}
	plainDMMsg := &models.DMMessage{ID: "d1", DMChannelID: "dc1", UserID: target, Content: strPtr("buy now")}
	e2eeDMMsg := &models.DMMessage{ID: "d2", DMChannelID: "dc1", UserID: target, EncryptionVersion: 1}
	voiceMsg := &models.VoiceMessage{ID: "v1", ChannelID: "vc1", UserID: target, Content: strPtr("voice insult")}
	dmChannel := &models.DMChannel{ID: "dc1", User1ID: target, User2ID: reporter}
	foreignDMChannel := &models.DMChannel{ID: "dc1", User1ID: target, User2ID: other}
	base := models.CreateReportRequest{Reason: "harassment", Description: "long enough text"}

	tests := []struct {
		name        string
		req         func() models.CreateReportRequest
		msg         *models.Message
		dmMsg       *models.DMMessage
		dmCh        *models.DMChannel
		voiceMsg    *models.VoiceMessage
		wantErr     error
		wantExcerpt string
		wantSource  string
	}{
		{
			name: "should snapshot stored text and discard the client excerpt for a plaintext channel message",
			req: func() models.CreateReportRequest {
				r := base
				r.MessageID = "m1"
				r.MessageExcerpt = "spoofed"
				return r
			},
			msg:         plainChannelMsg,
			wantExcerpt: "you suck",
			wantSource:  models.ExcerptSourceServer,
		},
		{
			name: "should keep the client excerpt for an E2EE channel message",
			req: func() models.CreateReportRequest {
				r := base
				r.MessageID = "m2"
				r.MessageExcerpt = "decrypted locally"
				return r
			},
			msg:         e2eeChannelMsg,
			wantExcerpt: "decrypted locally",
			wantSource:  models.ExcerptSourceClient,
		},
		{
			name:    "should refuse a channel message written by someone else",
			req:     func() models.CreateReportRequest { r := base; r.MessageID = "m1"; return r },
			msg:     &models.Message{ID: "m1", ChannelID: "c1", UserID: other},
			wantErr: pkg.ErrForbidden,
		},
		{
			name:    "should refuse an unknown channel message",
			req:     func() models.CreateReportRequest { r := base; r.MessageID = "missing"; return r },
			wantErr: pkg.ErrNotFound,
		},
		{
			name:        "should snapshot a plaintext DM message when the reporter is a participant",
			req:         func() models.CreateReportRequest { r := base; r.DMMessageID = "d1"; return r },
			dmMsg:       plainDMMsg,
			dmCh:        dmChannel,
			wantExcerpt: "buy now",
			wantSource:  models.ExcerptSourceServer,
		},
		{
			name: "should keep the client excerpt for an E2EE DM message",
			req: func() models.CreateReportRequest {
				r := base
				r.DMMessageID = "d2"
				r.MessageExcerpt = "secret text"
				return r
			},
			dmMsg:       e2eeDMMsg,
			dmCh:        dmChannel,
			wantExcerpt: "secret text",
			wantSource:  models.ExcerptSourceClient,
		},
		{
			name:    "should refuse a DM message when the reporter is not a participant",
			req:     func() models.CreateReportRequest { r := base; r.DMMessageID = "d1"; return r },
			dmMsg:   plainDMMsg,
			dmCh:    foreignDMChannel,
			wantErr: pkg.ErrForbidden,
		},
		{
			name:        "should snapshot a voice-chat message",
			req:         func() models.CreateReportRequest { r := base; r.VoiceMessageID = "v1"; return r },
			voiceMsg:    voiceMsg,
			wantExcerpt: "voice insult",
			wantSource:  models.ExcerptSourceServer,
		},
		{
			name:     "should refuse a voice-chat message written by someone else",
			req:      func() models.CreateReportRequest { r := base; r.VoiceMessageID = "v1"; return r },
			voiceMsg: &models.VoiceMessage{ID: "v1", ChannelID: "vc1", UserID: other},
			wantErr:  pkg.ErrForbidden,
		},
		{
			name:    "should refuse two message ids at once",
			req:     func() models.CreateReportRequest { r := base; r.MessageID = "m1"; r.VoiceMessageID = "v1"; return r },
			wantErr: pkg.ErrBadRequest,
		},
		{
			name:    "should refuse an excerpt without a message reference",
			req:     func() models.CreateReportRequest { r := base; r.MessageExcerpt = "orphan"; return r },
			wantErr: pkg.ErrBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &stubReportRepo{}
			svc := NewReportService(repo, nil, stubActiveUserRepo{}, nil,
				stubMessageRepo{msg: tt.msg}, stubDMRepoForReport{msg: tt.dmMsg, ch: tt.dmCh},
				stubVoiceMessageRepo{msg: tt.voiceMsg}, nil, nil)

			req := tt.req()
			report, err := svc.CreateReport(context.Background(), "u-reporter", "u-target", &req)

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
			if got := derefString(report.ExcerptSource); got != tt.wantSource {
				t.Fatalf("source: want %q, got %q", tt.wantSource, got)
			}
			ids := []*string{report.MessageID, report.DMMessageID, report.VoiceMessageID}
			set := 0
			for _, id := range ids {
				if id != nil {
					set++
				}
			}
			if set != 1 {
				t.Fatalf("exactly one message id must be carried onto the report, got %+v", report)
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
