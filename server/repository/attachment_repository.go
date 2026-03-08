package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// AttachmentRepository defines data access for file attachments.
// GetByMessageIDs batch-loads attachments for multiple messages (avoids N+1).
type AttachmentRepository interface {
	Create(ctx context.Context, attachment *models.Attachment) error
	GetByMessageID(ctx context.Context, messageID string) ([]models.Attachment, error)
	GetByMessageIDs(ctx context.Context, messageIDs []string) ([]models.Attachment, error)
	Delete(ctx context.Context, id string) error
}
