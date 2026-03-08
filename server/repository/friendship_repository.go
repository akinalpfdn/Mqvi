package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// FriendshipRepository defines data access for friendships.
type FriendshipRepository interface {
	// Create creates a new friendship record (status = pending).
	Create(ctx context.Context, friendship *models.Friendship) error

	GetByID(ctx context.Context, id string) (*models.Friendship, error)

	// GetByPair finds the record between two users (direction-independent).
	GetByPair(ctx context.Context, userID, friendID string) (*models.Friendship, error)

	// ListFriends returns accepted friends. Bidirectional: user_id = me OR friend_id = me.
	ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	// ListIncoming returns pending requests where friend_id = me.
	ListIncoming(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	// ListOutgoing returns pending requests where user_id = me.
	ListOutgoing(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	UpdateStatus(ctx context.Context, id string, status models.FriendshipStatus) error
	Delete(ctx context.Context, id string) error

	// DeleteByPair deletes the record between two users (direction-independent).
	DeleteByPair(ctx context.Context, userID, friendID string) error

	// ListBlocked returns users blocked by this user (user_id = me, status = blocked).
	ListBlocked(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	// IsBlocked checks if a block exists in either direction between two users.
	IsBlocked(ctx context.Context, userA, userB string) (bool, error)
}
