// Package services — DM channel lifecycle (create / list).
// Channel creation enforces `friends_only` privacy at creation time; the
// `message_request` flow is handled lazily on first message (see dm_message.go).
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

func (s *dmService) GetOrCreateChannel(ctx context.Context, userID, otherUserID string) (*models.DMChannelWithUser, error) {
	if userID == otherUserID {
		return nil, fmt.Errorf("%w: cannot create DM with yourself", pkg.ErrBadRequest)
	}

	otherUser, err := s.userRepo.GetByID(ctx, otherUserID)
	if err != nil {
		return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}

	user1, user2 := sortUserIDs(userID, otherUserID)

	existing, err := s.dmRepo.GetChannelByUsers(ctx, user1, user2)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing DM channel: %w", err)
	}

	if existing != nil {
		otherUser.PasswordHash = ""
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
	return s.dmRepo.ListChannels(ctx, userID)
}
