package repository

import (
	"context"
	"errors"

	"github.com/akinalp/mqvi/models"
)

// ErrDuplicateClientNonce is returned by a create whose (author, client_nonce) is already stored:
// the request is a retry of a send that went through, not a new message.
var ErrDuplicateClientNonce = errors.New("client nonce already used")

// MessageRepository defines data access for messages.
// GetByChannelID uses cursor-based pagination (beforeID + limit).
type MessageRepository interface {
	// Create stores the message; ErrDuplicateClientNonce when its author already used its nonce.
	Create(ctx context.Context, message *models.Message) error
	// GetByAuthorNonce returns the id and channel of the author's message with that nonce, or
	// pkg.ErrNotFound.
	GetByAuthorNonce(ctx context.Context, userID, nonce string) (id, channelID string, err error)
	GetByID(ctx context.Context, id string) (*models.Message, error)
	GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error)
	Update(ctx context.Context, message *models.Message) error
	Delete(ctx context.Context, id string) error
}
