// Package fileacl provides centralized file access control.
// Used by the /api/files/refresh endpoint to verify that a user still has
// permission to access a file before re-signing its URL.
//
// This is NOT used at serve-time — the signed URL is the serve-time credential.
// ACL is checked at URL generation (service layer) and URL refresh (this package).
package fileacl

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/files"
)

var ErrAccessDenied = errors.New("access denied")

// ChannelPermChecker resolves whether a user can read a channel's messages.
type ChannelPermChecker interface {
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
}

// ServerMemberChecker checks if a user is a member of a server.
type ServerMemberChecker interface {
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
}

// MessageLookup retrieves a message to find its channel.
type MessageLookup interface {
	GetByID(ctx context.Context, id string) (*models.Message, error)
}

// DMMessageLookup retrieves a DM message to find its channel.
type DMMessageLookup interface {
	GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error)
}

// DMChannelLookup retrieves a DM channel to verify participation.
type DMChannelLookup interface {
	GetChannelByID(ctx context.Context, id string) (*models.DMChannel, error)
}

// FeedbackLookup retrieves a feedback ticket to verify ownership.
type FeedbackLookup interface {
	GetTicketByID(ctx context.Context, id string) (*models.FeedbackTicketWithUser, error)
}

// ReportLookup retrieves a report to verify ownership.
type ReportLookup interface {
	GetByID(ctx context.Context, id string) (*models.Report, error)
}

// Checker performs file ACL checks based on file path type and scope.
type Checker struct {
	channelPerms ChannelPermChecker
	serverRepo   ServerMemberChecker
	messageRepo  MessageLookup
	dmRepo       DMMessageLookup
	dmChannelFn  DMChannelLookup
	feedbackRepo FeedbackLookup
	reportRepo   ReportLookup
}

// NewChecker creates a file ACL checker with all required dependencies.
func NewChecker(
	channelPerms ChannelPermChecker,
	serverRepo ServerMemberChecker,
	messageRepo MessageLookup,
	dmRepo DMMessageLookup,
	dmChannelFn DMChannelLookup,
	feedbackRepo FeedbackLookup,
	reportRepo ReportLookup,
) *Checker {
	return &Checker{
		channelPerms: channelPerms,
		serverRepo:   serverRepo,
		messageRepo:  messageRepo,
		dmRepo:       dmRepo,
		dmChannelFn:  dmChannelFn,
		feedbackRepo: feedbackRepo,
		reportRepo:   reportRepo,
	}
}

// Check verifies that userID has permission to access the file at filePath.
// filePath format: /api/files/<type>/<scopeID>/<filename>
func (c *Checker) Check(ctx context.Context, user *models.User, filePath string) error {
	after, found := strings.CutPrefix(filePath, files.URLPathPrefix+"/")
	if !found {
		return fmt.Errorf("%w: invalid file path", ErrAccessDenied)
	}

	parts := strings.SplitN(after, "/", 3)
	if len(parts) < 2 {
		return fmt.Errorf("%w: malformed file path", ErrAccessDenied)
	}

	kind := parts[0]
	scopeID := parts[1]

	switch files.Kind(kind) {
	case files.KindAvatar, files.KindWallpaper, files.KindServerIcon:
		// Accessible to any authenticated user
		return nil

	case files.KindMessage:
		// scopeID = messageID → look up message → check channel read permission
		return c.checkMessageFile(ctx, user.ID, scopeID)

	case files.KindDM:
		// scopeID = dmMessageID → look up DM message → check channel participation
		return c.checkDMFile(ctx, user.ID, scopeID)

	case files.KindSoundboard:
		// scopeID = serverID
		return c.checkServerMembership(ctx, user.ID, scopeID)

	case files.KindFeedback:
		// scopeID = ticketID
		return c.checkFeedbackAccess(ctx, user, scopeID)

	case files.KindReport:
		// scopeID = reportID
		return c.checkReportAccess(ctx, user, scopeID)

	default:
		return fmt.Errorf("%w: unknown file type", ErrAccessDenied)
	}
}

func (c *Checker) checkMessageFile(ctx context.Context, userID, messageID string) error {
	msg, err := c.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("%w: message not found", ErrAccessDenied)
	}
	perms, err := c.channelPerms.ResolveChannelPermissions(ctx, userID, msg.ChannelID)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAccessDenied, err)
	}
	if perms&models.PermReadMessages == 0 {
		return fmt.Errorf("%w: no read permission for channel", ErrAccessDenied)
	}
	return nil
}

func (c *Checker) checkDMFile(ctx context.Context, userID, dmMessageID string) error {
	msg, err := c.dmRepo.GetMessageByID(ctx, dmMessageID)
	if err != nil {
		return fmt.Errorf("%w: dm message not found", ErrAccessDenied)
	}
	ch, err := c.dmChannelFn.GetChannelByID(ctx, msg.DMChannelID)
	if err != nil {
		return fmt.Errorf("%w: dm channel not found", ErrAccessDenied)
	}
	if ch.User1ID != userID && ch.User2ID != userID {
		return fmt.Errorf("%w: not a participant of this DM", ErrAccessDenied)
	}
	return nil
}

func (c *Checker) checkServerMembership(ctx context.Context, userID, serverID string) error {
	isMember, err := c.serverRepo.IsMember(ctx, serverID, userID)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAccessDenied, err)
	}
	if !isMember {
		return fmt.Errorf("%w: not a server member", ErrAccessDenied)
	}
	return nil
}

func (c *Checker) checkFeedbackAccess(ctx context.Context, user *models.User, ticketID string) error {
	if user.IsPlatformAdmin {
		return nil
	}
	ticket, err := c.feedbackRepo.GetTicketByID(ctx, ticketID)
	if err != nil {
		return fmt.Errorf("%w: feedback ticket not found", ErrAccessDenied)
	}
	if ticket.UserID != user.ID {
		return fmt.Errorf("%w: not the ticket owner", ErrAccessDenied)
	}
	return nil
}

func (c *Checker) checkReportAccess(ctx context.Context, user *models.User, reportID string) error {
	if user.IsPlatformAdmin {
		return nil
	}
	report, err := c.reportRepo.GetByID(ctx, reportID)
	if err != nil {
		return fmt.Errorf("%w: report not found", ErrAccessDenied)
	}
	if report.ReporterID != user.ID {
		return fmt.Errorf("%w: not the reporter", ErrAccessDenied)
	}
	return nil
}
