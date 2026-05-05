package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"

	"github.com/google/uuid"
)

type FriendshipService interface {
	AreFriends(ctx context.Context, userA, userB string) (bool, error)
	SendRequest(ctx context.Context, senderID string, req *models.SendFriendRequestRequest) (*models.FriendshipWithUser, error)
	AcceptRequest(ctx context.Context, userID, requestID string) (*models.FriendshipWithUser, error)
	DeclineRequest(ctx context.Context, userID, requestID string) error
	RemoveFriend(ctx context.Context, userID, targetUserID string) error
	ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)
	ListRequests(ctx context.Context, userID string) (*FriendRequestsResponse, error)
	SetDMAcceptor(acceptor DMRequestAcceptor)
}

// DMRequestAcceptor is a minimal ISP interface for auto-accepting pending DMs.
type DMRequestAcceptor interface {
	AcceptPendingChannels(ctx context.Context, userA, userB string) error
}

type FriendRequestsResponse struct {
	Incoming []models.FriendshipWithUser `json:"incoming"`
	Outgoing []models.FriendshipWithUser `json:"outgoing"`
}

type friendshipService struct {
	friendRepo  repository.FriendshipRepository
	userRepo    repository.UserRepository
	hub         ws.Broadcaster
	dmAcceptor  DMRequestAcceptor
	urlSigner   FileURLSigner
}

func NewFriendshipService(
	friendRepo repository.FriendshipRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
	urlSigner FileURLSigner,
) FriendshipService {
	return &friendshipService{
		friendRepo: friendRepo,
		userRepo:   userRepo,
		hub:        hub,
		urlSigner:  urlSigner,
	}
}

func (s *friendshipService) SetDMAcceptor(acceptor DMRequestAcceptor) {
	s.dmAcceptor = acceptor
}

// AreFriends checks if two users have an accepted friendship. Satisfies FriendChecker ISP.
func (s *friendshipService) AreFriends(ctx context.Context, userA, userB string) (bool, error) {
	f, err := s.friendRepo.GetByPair(ctx, userA, userB)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	return f.Status == models.FriendshipStatusAccepted, nil
}

func (s *friendshipService) SendRequest(ctx context.Context, senderID string, req *models.SendFriendRequestRequest) (*models.FriendshipWithUser, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	target, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: user %q not found", pkg.ErrNotFound, req.Username)
		}
		return nil, err
	}

	if senderID == target.ID {
		return nil, fmt.Errorf("%w: cannot send friend request to yourself", pkg.ErrBadRequest)
	}

	existing, err := s.friendRepo.GetByPair(ctx, senderID, target.ID)
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return nil, err
	}

	if existing != nil {
		switch existing.Status {
		case models.FriendshipStatusAccepted:
			return nil, fmt.Errorf("%w: already friends with %s", pkg.ErrAlreadyExists, req.Username)
		case models.FriendshipStatusPending:
			// Mutual request: other party already sent one -> auto-accept
			if existing.UserID == target.ID {
				return s.acceptExisting(ctx, existing, senderID)
			}
			return nil, fmt.Errorf("%w: friend request already sent to %s", pkg.ErrAlreadyExists, req.Username)
		case models.FriendshipStatusBlocked:
			// Don't reveal blocked state
			return nil, fmt.Errorf("%w: user %q not found", pkg.ErrNotFound, req.Username)
		}
	}

	now := time.Now().UTC()
	friendship := &models.Friendship{
		ID:        uuid.New().String(),
		UserID:    senderID,
		FriendID:  target.ID,
		Status:    models.FriendshipStatusPending,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.friendRepo.Create(ctx, friendship); err != nil {
		return nil, err
	}

	sender, err := s.userRepo.GetByID(ctx, senderID)
	if err != nil {
		return nil, err
	}

	result := &models.FriendshipWithUser{
		ID:               friendship.ID,
		Status:           friendship.Status,
		CreatedAt:        friendship.CreatedAt,
		UserID:           target.ID,
		Username:         target.Username,
		DisplayName:      target.DisplayName,
		AvatarURL:        s.urlSigner.SignURLPtr(target.AvatarURL),
		UserStatus:       string(target.Status),
		UserCustomStatus: target.CustomStatus,
	}

	// Notify target
	s.hub.BroadcastToUser(target.ID, ws.Event{
		Op: ws.OpFriendRequestCreate,
		Data: models.FriendshipWithUser{
			ID:               friendship.ID,
			Status:           friendship.Status,
			CreatedAt:        friendship.CreatedAt,
			UserID:           sender.ID,
			Username:         sender.Username,
			DisplayName:      sender.DisplayName,
			AvatarURL:        s.urlSigner.SignURLPtr(sender.AvatarURL),
			UserStatus:       string(sender.Status),
			UserCustomStatus: sender.CustomStatus,
		},
	})

	return result, nil
}

// acceptExisting auto-accepts a mutual friend request.
func (s *friendshipService) acceptExisting(ctx context.Context, existing *models.Friendship, acceptorID string) (*models.FriendshipWithUser, error) {
	if err := s.friendRepo.UpdateStatus(ctx, existing.ID, models.FriendshipStatusAccepted); err != nil {
		return nil, err
	}

	sender, err := s.userRepo.GetByID(ctx, existing.UserID)
	if err != nil {
		return nil, err
	}
	acceptor, err := s.userRepo.GetByID(ctx, acceptorID)
	if err != nil {
		return nil, err
	}

	// Notify original sender
	s.hub.BroadcastToUser(existing.UserID, ws.Event{
		Op: ws.OpFriendRequestAccept,
		Data: models.FriendshipWithUser{
			ID:               existing.ID,
			Status:           models.FriendshipStatusAccepted,
			CreatedAt:        existing.CreatedAt,
			UserID:           acceptor.ID,
			Username:         acceptor.Username,
			DisplayName:      acceptor.DisplayName,
			AvatarURL:        s.urlSigner.SignURLPtr(acceptor.AvatarURL),
			UserStatus:       string(acceptor.Status),
			UserCustomStatus: acceptor.CustomStatus,
		},
	})

	// Auto-accept any pending DM requests between the two users
	if s.dmAcceptor != nil {
		_ = s.dmAcceptor.AcceptPendingChannels(ctx, existing.UserID, acceptorID)
	}

	return &models.FriendshipWithUser{
		ID:               existing.ID,
		Status:           models.FriendshipStatusAccepted,
		CreatedAt:        existing.CreatedAt,
		UserID:           sender.ID,
		Username:         sender.Username,
		DisplayName:      sender.DisplayName,
		AvatarURL:        s.urlSigner.SignURLPtr(sender.AvatarURL),
		UserStatus:       string(sender.Status),
		UserCustomStatus: sender.CustomStatus,
	}, nil
}

func (s *friendshipService) AcceptRequest(ctx context.Context, userID, requestID string) (*models.FriendshipWithUser, error) {
	friendship, err := s.friendRepo.GetByID(ctx, requestID)
	if err != nil {
		return nil, err
	}

	// Only the recipient can accept
	if friendship.FriendID != userID {
		return nil, fmt.Errorf("%w: you can only accept requests sent to you", pkg.ErrForbidden)
	}

	if friendship.Status != models.FriendshipStatusPending {
		return nil, fmt.Errorf("%w: request is not pending", pkg.ErrBadRequest)
	}

	if err := s.friendRepo.UpdateStatus(ctx, requestID, models.FriendshipStatusAccepted); err != nil {
		return nil, err
	}

	sender, err := s.userRepo.GetByID(ctx, friendship.UserID)
	if err != nil {
		return nil, err
	}

	acceptor, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	// Notify sender
	s.hub.BroadcastToUser(friendship.UserID, ws.Event{
		Op: ws.OpFriendRequestAccept,
		Data: models.FriendshipWithUser{
			ID:               friendship.ID,
			Status:           models.FriendshipStatusAccepted,
			CreatedAt:        friendship.CreatedAt,
			UserID:           acceptor.ID,
			Username:         acceptor.Username,
			DisplayName:      acceptor.DisplayName,
			AvatarURL:        s.urlSigner.SignURLPtr(acceptor.AvatarURL),
			UserStatus:       string(acceptor.Status),
			UserCustomStatus: acceptor.CustomStatus,
		},
	})

	// Auto-accept any pending DM requests between the two users
	if s.dmAcceptor != nil {
		_ = s.dmAcceptor.AcceptPendingChannels(ctx, friendship.UserID, friendship.FriendID)
	}

	return &models.FriendshipWithUser{
		ID:               friendship.ID,
		Status:           models.FriendshipStatusAccepted,
		CreatedAt:        friendship.CreatedAt,
		UserID:           sender.ID,
		Username:         sender.Username,
		DisplayName:      sender.DisplayName,
		AvatarURL:        s.urlSigner.SignURLPtr(sender.AvatarURL),
		UserStatus:       string(sender.Status),
		UserCustomStatus: sender.CustomStatus,
	}, nil
}

// DeclineRequest declines or cancels a friend request. Both sender and recipient can do this.
func (s *friendshipService) DeclineRequest(ctx context.Context, userID, requestID string) error {
	friendship, err := s.friendRepo.GetByID(ctx, requestID)
	if err != nil {
		return err
	}

	if friendship.UserID != userID && friendship.FriendID != userID {
		return fmt.Errorf("%w: not your friend request", pkg.ErrForbidden)
	}

	if friendship.Status != models.FriendshipStatusPending {
		return fmt.Errorf("%w: request is not pending", pkg.ErrBadRequest)
	}

	if err := s.friendRepo.Delete(ctx, requestID); err != nil {
		return err
	}

	// Notify the other party
	otherUserID := friendship.UserID
	if friendship.UserID == userID {
		otherUserID = friendship.FriendID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op: ws.OpFriendRequestDecline,
		Data: map[string]string{
			"id":      requestID,
			"user_id": userID,
		},
	})

	return nil
}

func (s *friendshipService) RemoveFriend(ctx context.Context, userID, targetUserID string) error {
	friendship, err := s.friendRepo.GetByPair(ctx, userID, targetUserID)
	if err != nil {
		return err
	}

	if friendship.Status != models.FriendshipStatusAccepted {
		return fmt.Errorf("%w: not friends with this user", pkg.ErrBadRequest)
	}

	if err := s.friendRepo.DeleteByPair(ctx, userID, targetUserID); err != nil {
		return err
	}

	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op: ws.OpFriendRemove,
		Data: map[string]string{
			"user_id": userID,
		},
	})

	return nil
}

func (s *friendshipService) ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	friends, err := s.friendRepo.ListFriends(ctx, userID)
	if err != nil {
		return nil, err
	}

	if friends == nil {
		friends = []models.FriendshipWithUser{}
	}
	for i := range friends {
		friends[i].AvatarURL = s.urlSigner.SignURLPtr(friends[i].AvatarURL)
	}
	return friends, nil
}

func (s *friendshipService) ListRequests(ctx context.Context, userID string) (*FriendRequestsResponse, error) {
	incoming, err := s.friendRepo.ListIncoming(ctx, userID)
	if err != nil {
		return nil, err
	}

	outgoing, err := s.friendRepo.ListOutgoing(ctx, userID)
	if err != nil {
		return nil, err
	}

	if incoming == nil {
		incoming = []models.FriendshipWithUser{}
	}
	if outgoing == nil {
		outgoing = []models.FriendshipWithUser{}
	}
	for i := range incoming {
		incoming[i].AvatarURL = s.urlSigner.SignURLPtr(incoming[i].AvatarURL)
	}
	for i := range outgoing {
		outgoing[i].AvatarURL = s.urlSigner.SignURLPtr(outgoing[i].AvatarURL)
	}

	return &FriendRequestsResponse{
		Incoming: incoming,
		Outgoing: outgoing,
	}, nil
}
