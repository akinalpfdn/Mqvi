package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// AttachmentRepository, dosya eki veritabanı işlemleri için interface.
//
// GetByMessageIDs — batch loading:
// N+1 sorgu problemini önler. 50 mesaj yüklendiğinde her biri için
// ayrı ayrı "SELECT * FROM attachments WHERE message_id = ?" yapmak yerine
// tek sorguda "WHERE message_id IN (?, ?, ...)" ile hepsini alır.
type AttachmentRepository interface {
	Create(ctx context.Context, attachment *models.Attachment) error
	GetByMessageID(ctx context.Context, messageID string) ([]models.Attachment, error)
	GetByMessageIDs(ctx context.Context, messageIDs []string) ([]models.Attachment, error)
	Delete(ctx context.Context, id string) error
}
