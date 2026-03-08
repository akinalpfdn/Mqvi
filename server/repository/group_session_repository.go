package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// GroupSessionRepository defines data access for Sender Key group sessions.
// The server stores session data as opaque blobs.
type GroupSessionRepository interface {
	// Upsert creates or updates a group session for (channel_id, sender_user_id, sender_device_id, session_id).
	Upsert(ctx context.Context, channelID, senderUserID, senderDeviceID string, req *models.CreateGroupSessionRequest) error
	// GetByChannel returns all active group sessions for a channel.
	GetByChannel(ctx context.Context, channelID string) ([]models.ChannelGroupSession, error)
	// DeleteByChannel removes all sessions for a channel (called during key rotation).
	DeleteByChannel(ctx context.Context, channelID string) error
	// DeleteByUser removes a user's sessions from a channel (called when user leaves).
	DeleteByUser(ctx context.Context, channelID, userID string) error
}
