package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

type FeedbackRepository interface {
	CreateTicket(ctx context.Context, ticket *models.FeedbackTicket) error
	GetTicketByID(ctx context.Context, id string) (*models.FeedbackTicketWithUser, error)
	ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	ListAll(ctx context.Context, status, ticketType string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	UpdateStatus(ctx context.Context, id string, status models.FeedbackStatus) error

	DeleteTicket(ctx context.Context, id string) error

	CreateReply(ctx context.Context, reply *models.FeedbackReply) error
	GetRepliesByTicketID(ctx context.Context, ticketID string) ([]models.FeedbackReplyWithUser, error)

	CreateAttachment(ctx context.Context, att *models.FeedbackAttachment) error
	GetAttachmentsByTicketID(ctx context.Context, ticketID string) ([]models.FeedbackAttachment, error)
}
