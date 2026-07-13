// Package services — DM channel lifecycle (create / list).
// Channel creation enforces `friends_only` privacy at creation time; the
// `message_request` flow is handled lazily on first message (see dm_message.go).
package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

func (s *dmService) GetOrCreateChannel(ctx context.Context, userID, otherUserID string) (*models.DMChannelWithUser, error) {
	if userID == otherUserID {
		return nil, fmt.Errorf("%w: cannot create DM with yourself", pkg.ErrBadRequest)
	}

	// Active user only — DM cannot be created with a deleted/tombstone user.
	otherUser, err := s.userRepo.GetActiveByID(ctx, otherUserID)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
		}
		return nil, fmt.Errorf("failed to look up user: %w", err)
	}

	user1, user2 := sortUserIDs(userID, otherUserID)

	existing, err := s.dmRepo.GetChannelByUsers(ctx, user1, user2)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing DM channel: %w", err)
	}

	if existing != nil {
		otherUser.PasswordHash = ""
		otherUser.AvatarURL = s.urlSigner.SignURLPtr(otherUser.AvatarURL)
		return &models.DMChannelWithUser{
			ID:            existing.ID,
			OtherUser:     otherUser,
			Status:        existing.Status,
			InitiatedBy:   existing.InitiatedBy,
			CreatedAt:     existing.CreatedAt,
			LastMessageAt: existing.LastMessageAt,
		}, nil
	}

	// Check friends_only at channel creation time (blocks DM window entirely)
	// Platform admins bypass all DM privacy restrictions
	sender, _ := s.userRepo.GetByID(ctx, userID)
	isPlatformAdmin := sender != nil && sender.IsPlatformAdmin

	if !isPlatformAdmin && otherUser.DMPrivacy == "friends_only" && s.friendChecker != nil {
		friends, err := s.friendChecker.AreFriends(ctx, userID, otherUserID)
		if err != nil {
			return nil, fmt.Errorf("failed to check friendship: %w", err)
		}
		if !friends {
			return nil, fmt.Errorf("%w: this user only accepts messages from friends", pkg.ErrForbidden)
		}
	}

	// Channel always starts as "accepted" — pending status is set on first message in SendMessage
	channel := &models.DMChannel{
		User1ID: user1,
		User2ID: user2,
		Status:  models.DMStatusAccepted,
	}
	if err := s.dmRepo.CreateChannel(ctx, channel); err != nil {
		return nil, fmt.Errorf("failed to create DM channel: %w", err)
	}

	otherUser.AvatarURL = s.urlSigner.SignURLPtr(otherUser.AvatarURL)
	result := &models.DMChannelWithUser{
		ID:            channel.ID,
		OtherUser:     otherUser,
		Status:        channel.Status,
		InitiatedBy:   channel.InitiatedBy,
		CreatedAt:     channel.CreatedAt,
		LastMessageAt: channel.LastMessageAt,
	}

	// Notify both users (each sees the other as the "other user")
	currentUser, err := s.userRepo.GetByID(ctx, userID)
	if err == nil {
		currentUser.PasswordHash = ""
		currentUser.AvatarURL = s.urlSigner.SignURLPtr(currentUser.AvatarURL)
		s.hub.BroadcastToUser(otherUserID, ws.Event{
			Op: ws.OpDMChannelCreate,
			Data: models.DMChannelWithUser{
				ID:            channel.ID,
				OtherUser:     currentUser,
				CreatedAt:     channel.CreatedAt,
				LastMessageAt: channel.LastMessageAt,
			},
		})
	}

	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDMChannelCreate,
		Data: result,
	})

	return result, nil
}

func (s *dmService) ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error) {
	channels, err := s.dmRepo.ListChannels(ctx, userID)
	if err != nil {
		return nil, err
	}
	for i := range channels {
		if channels[i].OtherUser != nil {
			channels[i].OtherUser.AvatarURL = s.urlSigner.SignURLPtr(channels[i].OtherUser.AvatarURL)
		}
	}
	return channels, nil
}

// MarkRead records that the user has read this conversation up to messageID (empty means
// all of it), then tells their other devices so the badge and any delivered notification
// clear there too. Reading on the desktop is what should silence the phone.
//
// The count is read back from the database rather than assumed to be zero: a message can
// arrive between the client choosing a watermark and this write landing, and reporting an
// optimistic zero would hide it.
func (s *dmService) MarkRead(ctx context.Context, userID, channelID, messageID string) (int, error) {
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return 0, err
	}

	// No message named: the client is clearing a conversation it hasn't loaded.
	var err error
	if messageID == "" {
		err = s.dmRepo.MarkReadLatest(ctx, userID, channelID)
	} else {
		err = s.dmRepo.MarkRead(ctx, userID, channelID, messageID)
	}
	if err != nil {
		return 0, err
	}

	unread, err := s.dmRepo.CountUnread(ctx, userID, channelID)
	if err != nil {
		return 0, err
	}

	// Only this user's sessions — the other participant's unread is their own business.
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpDMRead,
		Data: map[string]any{
			"dm_channel_id": channelID,
			"unread_count":  unread,
		},
	})

	// Devices with no live socket keep showing the notification until they are opened;
	// a data push retracts it there. Only worth sending once nothing is left unread.
	if unread == 0 && s.pushNotifier != nil {
		s.pushNotifier.NotifyDMRead(userID, channelID)
	}

	return unread, nil
}
