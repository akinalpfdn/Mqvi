package fileacl

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
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
		&mockMessageLookup{err: errors.New("not found")},
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
