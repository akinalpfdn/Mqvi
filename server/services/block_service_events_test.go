package services

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// The client (blockStore.handleUserBlock) reads user_id as the blocker and blocked_user_id as
// the target from BOTH copies of the event; a payload that only carries {user_id} can never
// match on a second device. This pins the contract.
type stubBlockFriendRepo struct {
	repository.FriendshipRepository
	rows map[string]*models.Friendship
}

func (s *stubBlockFriendRepo) GetByPair(_ context.Context, a, b string) (*models.Friendship, error) {
	for _, f := range s.rows {
		if (f.UserID == a && f.FriendID == b) || (f.UserID == b && f.FriendID == a) {
			return f, nil
		}
	}
	return nil, fmt.Errorf("%w: pair", pkg.ErrNotFound)
}

func (s *stubBlockFriendRepo) GetDirected(_ context.Context, a, b string) (*models.Friendship, error) {
	for _, f := range s.rows {
		if f.UserID == a && f.FriendID == b {
			return f, nil
		}
	}
	return nil, fmt.Errorf("%w: directed", pkg.ErrNotFound)
}

func (s *stubBlockFriendRepo) blockRow(blocker, blocked string) *models.Friendship {
	for _, f := range s.rows {
		if f.UserID == blocker && f.FriendID == blocked && f.Status == models.FriendshipStatusBlocked {
			return f
		}
	}
	return nil
}

func (s *stubBlockFriendRepo) Create(_ context.Context, f *models.Friendship) error {
	s.rows[f.ID] = f
	return nil
}

func (s *stubBlockFriendRepo) Delete(_ context.Context, id string) error {
	delete(s.rows, id)
	return nil
}

type stubBlockUserRepo struct{ repository.UserRepository }

func (stubBlockUserRepo) GetActiveByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id}, nil
}

type capturedEvent struct {
	to    string
	event ws.Event
}

type stubBlockHub struct {
	ws.BroadcastAndRegisterPeers
	sent []capturedEvent
}

func (h *stubBlockHub) BroadcastToUser(userID string, event ws.Event) {
	h.sent = append(h.sent, capturedEvent{to: userID, event: event})
}

func (h *stubBlockHub) RemovePresencePeer(_, _ string) {}

func dataOf(t *testing.T, e ws.Event) map[string]string {
	t.Helper()
	d, ok := e.Data.(map[string]string)
	if !ok {
		t.Fatalf("event data is %T, want map[string]string", e.Data)
	}
	return d
}

func TestBlockEvents_CarryBlockerAndTargetToBothParties(t *testing.T) {
	hub := &stubBlockHub{}
	svc := NewBlockService(&stubBlockFriendRepo{rows: map[string]*models.Friendship{}}, stubBlockUserRepo{}, hub, nil)

	if err := svc.BlockUser(context.Background(), "alice", "bob"); err != nil {
		t.Fatalf("block: %v", err)
	}

	if len(hub.sent) != 2 {
		t.Fatalf("want 2 block events, got %d", len(hub.sent))
	}
	recipients := map[string]bool{}
	for _, ev := range hub.sent {
		recipients[ev.to] = true
		if ev.event.Op != ws.OpUserBlock {
			t.Fatalf("op: want %s, got %s", ws.OpUserBlock, ev.event.Op)
		}
		d := dataOf(t, ev.event)
		if d["user_id"] != "alice" || d["blocked_user_id"] != "bob" {
			t.Fatalf("event to %s: want {user_id: alice, blocked_user_id: bob}, got %v", ev.to, d)
		}
	}
	if !recipients["alice"] || !recipients["bob"] {
		t.Fatalf("both parties must be notified, got %v", recipients)
	}

	hub.sent = nil
	if err := svc.UnblockUser(context.Background(), "alice", "bob"); err != nil {
		t.Fatalf("unblock: %v", err)
	}
	if len(hub.sent) != 1 || hub.sent[0].to != "alice" || hub.sent[0].event.Op != ws.OpUserUnblock {
		t.Fatalf("want one user_unblock to alice, got %+v", hub.sent)
	}
	d := dataOf(t, hub.sent[0].event)
	if d["user_id"] != "alice" || d["unblocked_user_id"] != "bob" {
		t.Fatalf("unblock payload: want {user_id: alice, unblocked_user_id: bob}, got %v", d)
	}
}

// Blocking back must not erase the first block: both rows coexist, and an unblock only
// removes the caller's own row. Before this rule the second block silently deleted the first.
func TestMutualBlock_KeepsBothRows(t *testing.T) {
	repo := &stubBlockFriendRepo{rows: map[string]*models.Friendship{}}
	svc := NewBlockService(repo, stubBlockUserRepo{}, &stubBlockHub{}, nil)
	ctx := context.Background()

	if err := svc.BlockUser(ctx, "bob", "alice"); err != nil {
		t.Fatalf("bob blocks alice: %v", err)
	}
	if err := svc.BlockUser(ctx, "alice", "bob"); err != nil {
		t.Fatalf("alice blocks bob back: %v", err)
	}
	if repo.blockRow("bob", "alice") == nil || repo.blockRow("alice", "bob") == nil {
		t.Fatalf("both block rows must exist after a mutual block, got %d rows", len(repo.rows))
	}

	if err := svc.UnblockUser(ctx, "alice", "bob"); err != nil {
		t.Fatalf("alice unblocks bob: %v", err)
	}
	if repo.blockRow("alice", "bob") != nil {
		t.Fatalf("alice's row must be gone after her unblock")
	}
	if repo.blockRow("bob", "alice") == nil {
		t.Fatalf("bob's block must survive alice's unblock")
	}

	// Alice cannot unblock a block she does not own.
	if err := svc.UnblockUser(ctx, "alice", "bob"); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("second unblock: want %v, got %v", pkg.ErrBadRequest, err)
	}
}
