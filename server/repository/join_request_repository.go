package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// JoinRequestRepository manages pending join requests for approval-required servers.
type JoinRequestRepository interface {
	// Create records a pending request (idempotent — a re-request while one is pending is a no-op).
	Create(ctx context.Context, serverID, userID, inviteCode string) error
	// Delete removes a pending request and reports whether a row was actually removed,
	// so callers can treat "I deleted it" as "I own this approval" under concurrency.
	Delete(ctx context.Context, serverID, userID string) (bool, error)
	Exists(ctx context.Context, serverID, userID string) (bool, error)
	CountByServer(ctx context.Context, serverID string) (int, error)
	ListByServer(ctx context.Context, serverID string) ([]models.ServerJoinRequestWithUser, error)
}
