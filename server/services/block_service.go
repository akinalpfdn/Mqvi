// Package services — BlockService: user blocking.
//
// Uses "blocked" status in the friendships table — no separate table.
// Block: delete existing friendship/request -> create "blocked" record.
// user_id = blocker, friend_id = target.
//
// Bidirectional enforcement: A->B block = mutual message block.
// IsBlocked checks both directions — used in DM send.
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

// BlockService handles user blocking operations.
type BlockService interface {
	BlockUser(ctx context.Context, blockerID, targetID string) error
	UnblockUser(ctx context.Context, blockerID, targetID string) error
	ListBlocked(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)
	// IsBlocked checks bidirectional block between two users. Also satisfies BlockChecker ISP.
	IsBlocked(ctx context.Context, userA, userB string) (bool, error)
}

// BlockChecker is a minimal ISP interface for block checks (used by dmService etc.).
type BlockChecker interface {
	IsBlocked(ctx context.Context, userA, userB string) (bool, error)
}

// CallEnder ends a call between two users, if there is one.
type CallEnder interface {
	EndCallBetween(userID, otherID string)
}

type blockService struct {
	friendRepo repository.FriendshipRepository
	userRepo   repository.UserRepository
	hub        ws.BroadcastAndRegisterPeers
	urlSigner  FileURLSigner
	calls      CallEnder
}

func NewBlockService(
	friendRepo repository.FriendshipRepository,
	userRepo repository.UserRepository,
	hub ws.BroadcastAndRegisterPeers,
	urlSigner FileURLSigner,
	calls CallEnder,
) BlockService {
	return &blockService{
		friendRepo: friendRepo,
		userRepo:   userRepo,
		calls:      calls,
		hub:        hub,
		urlSigner:  urlSigner,
	}
}

func (s *blockService) BlockUser(ctx context.Context, blockerID, targetID string) error {
	if blockerID == targetID {
		return fmt.Errorf("%w: cannot block yourself", pkg.ErrBadRequest)
	}

	// Cannot block deleted/tombstone users — they're already inaccessible.
	if _, err := s.userRepo.GetActiveByID(ctx, targetID); err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: user not found", pkg.ErrNotFound)
		}
		return fmt.Errorf("failed to look up user: %w", err)
	}

	// Each direction owns its own row: blocking back never deletes the other side's block,
	// so "their messages stay hidden" holds for both parties no matter who blocked last.
	mine, err := s.friendRepo.GetDirected(ctx, blockerID, targetID)
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return err
	}
	if mine != nil && mine.Status == models.FriendshipStatusBlocked {
		return fmt.Errorf("%w: user already blocked", pkg.ErrAlreadyExists)
	}
	theirs, err := s.friendRepo.GetDirected(ctx, targetID, blockerID)
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return err
	}

	// A pending/accepted friendship lives in exactly one direction; end it and tell the other
	// side. Their block row (if that is what "theirs" is) is left untouched.
	for _, f := range []*models.Friendship{mine, theirs} {
		if f == nil || f.Status == models.FriendshipStatusBlocked {
			continue
		}
		if err := s.friendRepo.Delete(ctx, f.ID); err != nil {
			return err
		}
		s.hub.BroadcastToUser(targetID, ws.Event{
			Op: ws.OpFriendRemove,
			Data: map[string]string{
				"user_id": blockerID,
			},
		})
	}

	now := time.Now().UTC()
	blocked := &models.Friendship{
		ID:        uuid.New().String(),
		UserID:    blockerID,
		FriendID:  targetID,
		Status:    models.FriendshipStatusBlocked,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.friendRepo.Create(ctx, blocked); err != nil {
		return fmt.Errorf("failed to create block record: %w", err)
	}

	// Blocking deletes the friendship row but not the DM channel, so the DM half of the entitlement
	// would survive. Drop both sides.
	s.hub.RemovePresencePeer(blockerID, targetID)

	// Notify both parties with one shape — user_id is always the blocker — so every device
	// of either side (blockStore.handleUserBlock) can tell which role it plays.
	blockEvent := ws.Event{
		Op: ws.OpUserBlock,
		Data: map[string]string{
			"user_id":         blockerID,
			"blocked_user_id": targetID,
		},
	}
	s.hub.BroadcastToUser(blockerID, blockEvent)
	s.hub.BroadcastToUser(targetID, blockEvent)

	// A call already ringing or running between them does not stop by itself: the media is peer
	// to peer and never passes the server again, so the blocked person could keep talking.
	s.calls.EndCallBetween(blockerID, targetID)

	return nil
}

// UnblockUser removes the caller's own block row. The other side's block, if any, survives.
func (s *blockService) UnblockUser(ctx context.Context, blockerID, targetID string) error {
	mine, err := s.friendRepo.GetDirected(ctx, blockerID, targetID)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: user is not blocked", pkg.ErrBadRequest)
		}
		return err
	}
	if mine.Status != models.FriendshipStatusBlocked {
		return fmt.Errorf("%w: user is not blocked", pkg.ErrBadRequest)
	}

	if err := s.friendRepo.Delete(ctx, mine.ID); err != nil {
		return err
	}

	s.hub.BroadcastToUser(blockerID, ws.Event{
		Op: ws.OpUserUnblock,
		Data: map[string]string{
			"user_id":           blockerID,
			"unblocked_user_id": targetID,
		},
	})

	return nil
}

func (s *blockService) ListBlocked(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	blocked, err := s.friendRepo.ListBlocked(ctx, userID)
	if err != nil {
		return nil, err
	}

	if blocked == nil {
		blocked = []models.FriendshipWithUser{}
	}
	for i := range blocked {
		blocked[i].AvatarURL = s.urlSigner.SignURLPtr(blocked[i].AvatarURL)
	}
	return blocked, nil
}

// IsBlocked checks bidirectional block — true if A->B or B->A "blocked" exists.
func (s *blockService) IsBlocked(ctx context.Context, userA, userB string) (bool, error) {
	return s.friendRepo.IsBlocked(ctx, userA, userB)
}
