package repository

import (
	"context"
	"time"

	"github.com/akinalp/mqvi/models"
)

// FeedbackListParams holds the filter/sort/paging inputs for the admin feedback
// list. SortKey is a UI-level key mapped to a whitelisted column by the repository —
// caller-supplied strings never reach ORDER BY.
type FeedbackListParams struct {
	AdminID  string   // requesting admin, drives per-ticket is_unread
	Statuses []string // OR-combined; empty means all
	Types    []string // OR-combined; empty means all
	SortKey  string   // whitelisted key; unknown falls back to created_at
	SortDir  string   // "asc" or "desc"; anything else means desc
	Limit    int
	Offset   int
}

type FeedbackRepository interface {
	CreateTicket(ctx context.Context, ticket *models.FeedbackTicket) error
	GetTicketByID(ctx context.Context, id string) (*models.FeedbackTicketWithUser, error)
	ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	ListAllForAdmin(ctx context.Context, p FeedbackListParams) ([]models.FeedbackTicketWithUser, int, error)
	UpdateStatus(ctx context.Context, id string, status models.FeedbackStatus) error

	// MarkTicketSeen records that adminID has viewed ticketID now (idempotent upsert).
	MarkTicketSeen(ctx context.Context, adminID, ticketID string) error

	DeleteTicket(ctx context.Context, id string) error

	CreateReply(ctx context.Context, reply *models.FeedbackReply) error
	GetRepliesByTicketID(ctx context.Context, ticketID string) ([]models.FeedbackReplyWithUser, error)

	CreateAttachment(ctx context.Context, att *models.FeedbackAttachment) error
	GetAttachmentsByTicketID(ctx context.Context, ticketID string) ([]models.FeedbackAttachment, error)

	// LatestCreatedAt returns the newest ticket's created_at, or nil when the
	// table is empty. Drives the admin "new feedback" badge.
	LatestCreatedAt(ctx context.Context) (*time.Time, error)

	// LatestAdminReplyForUser returns the newest admin-reply timestamp on any
	// ticket owned by userID, or nil. Drives the user's own feedback badge.
	LatestAdminReplyForUser(ctx context.Context, userID string) (*time.Time, error)
}
