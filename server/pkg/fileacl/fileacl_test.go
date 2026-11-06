package fileacl

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// ─── Mocks ──────────────────────────────────────────────────────────────────

type mockChannelPerms struct {
	perms models.Permission
	err   error
}

func (m *mockChannelPerms) ResolveChannelPermissions(_ context.Context, _, _ string) (models.Permission, error) {
	return m.perms, m.err
}

type mockServerMember struct {
	isMember bool
	err      error
}

func (m *mockServerMember) IsMember(_ context.Context, _, _ string) (bool, error) {
	return m.isMember, m.err
}

type mockMessageLookup struct {
	msg *models.Message
	err error
}

func (m *mockMessageLookup) GetByID(_ context.Context, _ string) (*models.Message, error) {
	return m.msg, m.err
}

type mockDMMessageLookup struct {
	msg *models.DMMessage
	err error
}

func (m *mockDMMessageLookup) GetMessageByID(_ context.Context, _ string) (*models.DMMessage, error) {
	return m.msg, m.err
}

type mockDMChannelLookup struct {
	ch  *models.DMChannel
	err error
}

func (m *mockDMChannelLookup) GetChannelByID(_ context.Context, _ string) (*models.DMChannel, error) {
	return m.ch, m.err
}

type mockFeedbackLookup struct {
	ticket *models.FeedbackTicketWithUser
	err    error
}

func (m *mockFeedbackLookup) GetTicketByID(_ context.Context, _ string) (*models.FeedbackTicketWithUser, error) {
	return m.ticket, m.err
}

type mockReportLookup struct {
	report *models.Report
	err    error
}

func (m *mockReportLookup) GetByID(_ context.Context, _ string) (*models.Report, error) {
	return m.report, m.err
}

// ─── Tests ──────────────────────────────────────────────────────────────────

func TestCheck_Avatar_AlwaysAllowed(t *testing.T) {
	c := NewChecker(nil, nil, nil, nil, nil, nil, nil)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/avatars/u1/pic.png"); err != nil {
		t.Fatalf("avatar should be allowed for any authenticated user: %v", err)
	}
}

func TestCheck_ServerIcon_AlwaysAllowed(t *testing.T) {
	c := NewChecker(nil, nil, nil, nil, nil, nil, nil)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/server-icons/s1/icon.png"); err != nil {
		t.Fatalf("server icon should be allowed: %v", err)
	}
}

func TestCheck_Wallpaper_AlwaysAllowed(t *testing.T) {
	c := NewChecker(nil, nil, nil, nil, nil, nil, nil)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/wallpapers/u1/bg.jpg"); err != nil {
		t.Fatalf("wallpaper should be allowed: %v", err)
	}
}

func TestCheck_Message_WithReadPermission(t *testing.T) {
	c := NewChecker(
		&mockChannelPerms{perms: models.PermReadMessages | models.PermSendMessages},
		nil,
		&mockMessageLookup{msg: &models.Message{ChannelID: "ch1"}},
		nil, nil, nil, nil,
	)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/messages/msg1/file.pdf"); err != nil {
		t.Fatalf("should allow with read permission: %v", err)
	}
}

func TestCheck_Message_WithoutReadPermission(t *testing.T) {
	c := NewChecker(
		&mockChannelPerms{perms: models.PermSendMessages}, // no ReadMessages
		nil,
		&mockMessageLookup{msg: &models.Message{ChannelID: "ch1"}},
		nil, nil, nil, nil,
	)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/messages/msg1/file.pdf"); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("should deny without read permission, got: %v", err)
	}
}

func TestCheck_Message_NotFound(t *testing.T) {
	c := NewChecker(
		nil, nil,
		&mockMessageLookup{err: pkg.ErrNotFound},
		nil, nil, nil, nil,
	)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/messages/msg1/file.pdf"); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("should deny when message not found, got: %v", err)
	}
}

func TestCheck_DM_Participant(t *testing.T) {
	c := NewChecker(
		nil, nil, nil,
		&mockDMMessageLookup{msg: &models.DMMessage{DMChannelID: "dm1"}},
		&mockDMChannelLookup{ch: &models.DMChannel{User1ID: "u1", User2ID: "u2"}},
		nil, nil,
	)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/dm/dmmsg1/img.png"); err != nil {
		t.Fatalf("should allow DM participant: %v", err)
	}
}

func TestCheck_DM_NonParticipant(t *testing.T) {
	c := NewChecker(
		nil, nil, nil,
		&mockDMMessageLookup{msg: &models.DMMessage{DMChannelID: "dm1"}},
		&mockDMChannelLookup{ch: &models.DMChannel{User1ID: "u1", User2ID: "u2"}},
		nil, nil,
	)
	user := &models.User{ID: "u3"} // not a participant
	if err := c.Check(context.Background(), user, "/api/files/dm/dmmsg1/img.png"); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("should deny non-participant, got: %v", err)
	}
}

func TestCheck_Soundboard_ServerMember(t *testing.T) {
	c := NewChecker(
		nil,
		&mockServerMember{isMember: true},
		nil, nil, nil, nil, nil,
	)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/soundboards/s1/boom.mp3"); err != nil {
		t.Fatalf("should allow server member: %v", err)
	}
}

func TestCheck_Soundboard_NonMember(t *testing.T) {
	c := NewChecker(
		nil,
		&mockServerMember{isMember: false},
		nil, nil, nil, nil, nil,
	)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/soundboards/s1/boom.mp3"); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("should deny non-member, got: %v", err)
	}
}

func TestCheck_Feedback_Owner(t *testing.T) {
	c := NewChecker(
		nil, nil, nil, nil, nil,
		&mockFeedbackLookup{ticket: &models.FeedbackTicketWithUser{
			FeedbackTicket: models.FeedbackTicket{UserID: "u1"},
		}},
		nil,
	)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/feedback/t1/screenshot.png"); err != nil {
		t.Fatalf("should allow ticket owner: %v", err)
	}
}

func TestCheck_Feedback_NonOwner(t *testing.T) {
	c := NewChecker(
		nil, nil, nil, nil, nil,
		&mockFeedbackLookup{ticket: &models.FeedbackTicketWithUser{
			FeedbackTicket: models.FeedbackTicket{UserID: "u1"},
		}},
		nil,
	)
	user := &models.User{ID: "u2"} // not owner, not admin
	if err := c.Check(context.Background(), user, "/api/files/feedback/t1/screenshot.png"); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("should deny non-owner, got: %v", err)
	}
}

func TestCheck_Feedback_PlatformAdmin(t *testing.T) {
	c := NewChecker(
		nil, nil, nil, nil, nil,
		&mockFeedbackLookup{ticket: &models.FeedbackTicketWithUser{
			FeedbackTicket: models.FeedbackTicket{UserID: "u1"},
		}},
		nil,
	)
	admin := &models.User{ID: "admin1", IsPlatformAdmin: true}
	if err := c.Check(context.Background(), admin, "/api/files/feedback/t1/screenshot.png"); err != nil {
		t.Fatalf("should allow platform admin: %v", err)
	}
}

func TestCheck_Report_Reporter(t *testing.T) {
	c := NewChecker(
		nil, nil, nil, nil, nil, nil,
		&mockReportLookup{report: &models.Report{ReporterID: "u1"}},
	)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/reports/r1/evidence.png"); err != nil {
		t.Fatalf("should allow reporter: %v", err)
	}
}

func TestCheck_Report_NonReporter(t *testing.T) {
	c := NewChecker(
		nil, nil, nil, nil, nil, nil,
		&mockReportLookup{report: &models.Report{ReporterID: "u1"}},
	)
	user := &models.User{ID: "u2"}
	if err := c.Check(context.Background(), user, "/api/files/reports/r1/evidence.png"); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("should deny non-reporter, got: %v", err)
	}
}

func TestCheck_Report_PlatformAdmin(t *testing.T) {
	c := NewChecker(
		nil, nil, nil, nil, nil, nil,
		&mockReportLookup{report: &models.Report{ReporterID: "u1"}},
	)
	admin := &models.User{ID: "admin1", IsPlatformAdmin: true}
	if err := c.Check(context.Background(), admin, "/api/files/reports/r1/evidence.png"); err != nil {
		t.Fatalf("should allow platform admin: %v", err)
	}
}

func TestCheck_InvalidPath(t *testing.T) {
	c := NewChecker(nil, nil, nil, nil, nil, nil, nil)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/other/foo"); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("should deny invalid path, got: %v", err)
	}
}

func TestCheck_UnknownType(t *testing.T) {
	c := NewChecker(nil, nil, nil, nil, nil, nil, nil)
	user := &models.User{ID: "u1"}
	if err := c.Check(context.Background(), user, "/api/files/unknown/scope/file.txt"); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("should deny unknown type, got: %v", err)
	}
}

// A lookup that failed has not said the file is off limits. Answered as a denial it turns every
// attachment into a 403/401 during a database hiccup, and the cause reaches no log.
func TestCheck_ShouldNotAnswerAFailedLookupAsADenial(t *testing.T) {
	dbDown := errors.New("database is locked")
	user := &models.User{ID: "u1"}
	cases := map[string]struct {
		checker *Checker
		path    string
	}{
		"message lookup": {NewChecker(nil, nil, &mockMessageLookup{err: dbDown}, nil, nil, nil, nil), "/api/files/messages/m1/a.pdf"},
		"channel permissions": {NewChecker(&mockChannelPerms{err: fmt.Errorf("failed to get user roles: %w", dbDown)}, nil,
			&mockMessageLookup{msg: &models.Message{ChannelID: "c1"}}, nil, nil, nil, nil), "/api/files/messages/m1/a.pdf"},
		"dm message lookup": {NewChecker(nil, nil, nil, &mockDMMessageLookup{err: dbDown}, nil, nil, nil), "/api/files/dm/d1/a.png"},
		"dm channel lookup": {NewChecker(nil, nil, nil, &mockDMMessageLookup{msg: &models.DMMessage{DMChannelID: "dm1"}},
			&mockDMChannelLookup{err: dbDown}, nil, nil), "/api/files/dm/d1/a.png"},
		"server membership": {NewChecker(nil, &mockServerMember{err: dbDown}, nil, nil, nil, nil, nil), "/api/files/soundboards/s1/a.mp3"},
		"feedback lookup":   {NewChecker(nil, nil, nil, nil, nil, &mockFeedbackLookup{err: dbDown}, nil), "/api/files/feedback/t1/a.png"},
		"report lookup":     {NewChecker(nil, nil, nil, nil, nil, nil, &mockReportLookup{err: dbDown}), "/api/files/reports/r1/a.png"},
	}
	for name, c := range cases {
		err := c.checker.Check(context.Background(), user, c.path)
		if err == nil || errors.Is(err, ErrAccessDenied) || !errors.Is(err, dbDown) {
			t.Errorf("%s failed: answered as %v, want the lookup error", name, err)
		}
	}
}

// Whatever the file belonged to being gone is still a denial, in either way repositories say it.
func TestCheck_ShouldDenyWhenWhatTheFileBelongedToIsGone(t *testing.T) {
	user := &models.User{ID: "u1"}
	cases := map[string]struct {
		checker *Checker
		path    string
	}{
		"deleted channel": {NewChecker(&mockChannelPerms{err: fmt.Errorf("failed to get channel for permission resolution: %w", pkg.ErrNotFound)}, nil,
			&mockMessageLookup{msg: &models.Message{ChannelID: "c1"}}, nil, nil, nil, nil), "/api/files/messages/m1/a.pdf"},
		"deleted dm message": {NewChecker(nil, nil, nil, &mockDMMessageLookup{err: fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)}, nil, nil, nil), "/api/files/dm/d1/a.png"},
		// The feedback repository wraps sql.ErrNoRows rather than pkg.ErrNotFound.
		"deleted feedback ticket": {NewChecker(nil, nil, nil, nil, nil, &mockFeedbackLookup{err: fmt.Errorf("failed to get feedback ticket: %w", sql.ErrNoRows)}, nil), "/api/files/feedback/t1/a.png"},
		"deleted report":          {NewChecker(nil, nil, nil, nil, nil, nil, &mockReportLookup{err: fmt.Errorf("%w: report r1", pkg.ErrNotFound)}), "/api/files/reports/r1/a.png"},
	}
	for name, c := range cases {
		if err := c.checker.Check(context.Background(), user, c.path); !errors.Is(err, ErrAccessDenied) {
			t.Errorf("%s answered as %v, want access denied", name, err)
		}
	}
}
