package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// DMRepository defines data access for direct messages.
type DMRepository interface {
	// Channel operations
	GetChannelByUsers(ctx context.Context, user1ID, user2ID string) (*models.DMChannel, error)
	GetChannelByID(ctx context.Context, id string) (*models.DMChannel, error)
	ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error)
	CreateChannel(ctx context.Context, channel *models.DMChannel) error
	UpdateChannelStatus(ctx context.Context, channelID, status string) error
	SetInitiatedBy(ctx context.Context, channelID, userID string) error
	CountMessagesBySender(ctx context.Context, channelID, userID string) (int, error)
	DeleteChannel(ctx context.Context, channelID string) error
	SetE2EEEnabled(ctx context.Context, channelID string, enabled bool) error
	// IsChannelMuted reports whether the user has an active mute (muted_until in the
	// future) on the DM channel — used to suppress push notifications.
	IsChannelMuted(ctx context.Context, userID, channelID string) (bool, error)

	// Read state
	//
	// MarkRead advances the user's read watermark to the given message and reports whether
	// it actually moved. Never moves backwards, so a late mark from a second device cannot
	// resurrect messages the user has already read. A message id that isn't in this channel
	// is a no-op. The "moved" result gates the broadcast and the retraction push — without
	// it, clicking through the sidebar wakes every device of the user for nothing.
	MarkRead(ctx context.Context, userID, channelID, messageID string) (moved bool, err error)
	// MarkReadLatest marks the whole conversation as read. The client often clears a DM it
	// has not loaded — from the sidebar, or "mark as read" — so it has no message to name.
	MarkReadLatest(ctx context.Context, userID, channelID string) (moved bool, err error)
	// CountUnread returns the messages in the channel the user has not read, written by
	// the other participant. Read back AFTER a MarkRead rather than assumed to be zero —
	// a message can land between the client picking a watermark and the write landing.
	CountUnread(ctx context.Context, userID, channelID string) (int, error)
	// HasRead reports whether the user's watermark has passed this message. It is what a
	// deferred push consults before it fires: "the user read it" is PROVED here, never claimed
	// by a client. A message id that isn't in the channel reads as unread.
	HasRead(ctx context.Context, userID, channelID, messageID string) (bool, error)

	// Message operations
	GetMessages(ctx context.Context, channelID string, beforeID string, limit int) ([]models.DMMessage, error)
	GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error)
	CreateMessage(ctx context.Context, msg *models.DMMessage) error
	UpdateMessage(ctx context.Context, id string, req *models.UpdateDMMessageRequest) error
	DeleteMessage(ctx context.Context, id string) error

	// Reaction operations
	ToggleReaction(ctx context.Context, messageID, userID, emoji string) (added bool, err error)
	GetReactionsByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error)
	GetReactionsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error)

	// Pin operations
	PinMessage(ctx context.Context, messageID string) error
	UnpinMessage(ctx context.Context, messageID string) error
	GetPinnedMessages(ctx context.Context, channelID string) ([]models.DMMessage, error)

	// Attachment operations
	CreateAttachment(ctx context.Context, attachment *models.DMAttachment) error
	GetAttachmentsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.DMAttachment, error)

	// Search operations (FTS5 full-text search with pagination)
	SearchMessages(ctx context.Context, channelID string, query string, limit, offset int) ([]models.DMMessage, int, error)
}
