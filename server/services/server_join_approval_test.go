package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// Stubs embed the full interface (nil) so only the methods each test path touches need
// implementing; any un-overridden method would panic if called, which is the point —
// it proves the flow doesn't reach it.

type stubInvite struct {
	InviteService
	serverID     string
	consumeCalls int
}

func (s *stubInvite) Validate(_ context.Context, _ string) (*models.Invite, error) {
	return &models.Invite{ServerID: s.serverID}, nil
}
func (s *stubInvite) Consume(_ context.Context, _ string) error { s.consumeCalls++; return nil }
func (s *stubInvite) ReleaseUse(_ context.Context, _ string) error { return nil }

type stubServerRepo struct {
	repository.ServerRepository
	member   bool
	server   *models.Server
	addCalls int
}

func (s *stubServerRepo) IsMember(_ context.Context, _, _ string) (bool, error) { return s.member, nil }
func (s *stubServerRepo) GetActiveByID(_ context.Context, _ string) (*models.Server, error) {
	return s.server, nil
}
func (s *stubServerRepo) AddMember(_ context.Context, _, _ string) error { s.addCalls++; return nil }

type stubBanRepo struct {
	repository.BanRepository
	banned bool
}

func (s *stubBanRepo) Exists(_ context.Context, _, _ string) (bool, error) { return s.banned, nil }

type stubJoinReqRepo struct {
	repository.JoinRequestRepository
	createCalls int
	count       int
	exists      bool
	deleteOK    bool
	deleteCalls int
}

func (s *stubJoinReqRepo) Create(_ context.Context, _, _, _ string) error { s.createCalls++; return nil }
func (s *stubJoinReqRepo) CountByServer(_ context.Context, _ string) (int, error) { return s.count, nil }
func (s *stubJoinReqRepo) Exists(_ context.Context, _, _ string) (bool, error) { return s.exists, nil }
func (s *stubJoinReqRepo) Delete(_ context.Context, _, _ string) (bool, error) {
	s.deleteCalls++
	return s.deleteOK, nil
}
func (s *stubJoinReqRepo) ListByServer(_ context.Context, _ string) ([]models.ServerJoinRequestWithUser, error) {
	return nil, nil
}

type stubRoleRepo struct{ repository.RoleRepository }

func (stubRoleRepo) GetDefaultByServer(_ context.Context, _ string) (*models.Role, error) {
	return &models.Role{ID: "role-default"}, nil
}
func (stubRoleRepo) AssignToUser(_ context.Context, _, _, _ string) error { return nil }
func (stubRoleRepo) GetByUserIDAndServer(_ context.Context, _, _ string) ([]models.Role, error) {
	return nil, nil
}

type stubUserRepo struct{ repository.UserRepository }

func (stubUserRepo) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id, Username: "u"}, nil
}

type stubHub struct{ ws.BroadcastAndManage }

func (stubHub) AddClientServerID(_, _ string)          {}
func (stubHub) BroadcastToUser(_ string, _ ws.Event)   {}
func (stubHub) BroadcastToServer(_ string, _ ws.Event) {}

type stubVoiceSync struct{}

func (stubVoiceSync) SyncServerStatesToUser(_, _ string) {}

type stubSigner struct{}

func (stubSigner) SignURL(u string) string      { return u }
func (stubSigner) SignURLPtr(u *string) *string { return u }

func newTestServerService(sr repository.ServerRepository, ban repository.BanRepository, jr repository.JoinRequestRepository, inv InviteService) ServerService {
	return NewServerService(
		nil, sr, nil, stubRoleRepo{}, nil, nil, stubUserRepo{},
		ban, jr, inv, stubHub{}, stubVoiceSync{}, nil, nil, stubSigner{}, nil,
	)
}

func TestJoinServer_ApprovalOff_JoinsDirectly(t *testing.T) {
	inv := &stubInvite{serverID: "s1"}
	sr := &stubServerRepo{server: &models.Server{ID: "s1", ApprovalRequired: false}}
	jr := &stubJoinReqRepo{}
	svc := newTestServerService(sr, &stubBanRepo{}, jr, inv)

	res, err := svc.JoinServer(context.Background(), "u1", "code")
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	if res.Pending {
		t.Fatal("approval-off join must not be pending")
	}
	if res.Server == nil {
		t.Fatal("direct join must return the server")
	}
	if sr.addCalls != 1 {
		t.Fatalf("AddMember calls = %d, want 1", sr.addCalls)
	}
	if inv.consumeCalls != 1 {
		t.Fatalf("Consume calls = %d, want 1 (direct join charges the invite)", inv.consumeCalls)
	}
	if jr.createCalls != 0 {
		t.Fatal("direct join must not create a join request")
	}
	// Choke-point cleanup: becoming a member clears any lingering request (e.g. approval was
	// toggled off after the user had already requested).
	if jr.deleteCalls != 1 {
		t.Fatalf("Delete (post-join cleanup) calls = %d, want 1", jr.deleteCalls)
	}
}

func TestJoinServer_ApprovalOn_CreatesPendingRequest(t *testing.T) {
	inv := &stubInvite{serverID: "s1"}
	sr := &stubServerRepo{server: &models.Server{ID: "s1", ApprovalRequired: true}}
	jr := &stubJoinReqRepo{}
	svc := newTestServerService(sr, &stubBanRepo{}, jr, inv)

	res, err := svc.JoinServer(context.Background(), "u1", "code")
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	if !res.Pending {
		t.Fatal("approval-on join must be pending")
	}
	if res.Server != nil {
		t.Fatal("pending join must not return a server")
	}
	if jr.createCalls != 1 {
		t.Fatalf("join request Create calls = %d, want 1", jr.createCalls)
	}
	// The core security invariant: a pending user is NOT a member and does NOT burn the invite.
	if sr.addCalls != 0 {
		t.Fatal("pending user must NOT be added to server_members")
	}
	if inv.consumeCalls != 0 {
		t.Fatal("invite must NOT be consumed on request (admin is the gate)")
	}
}

func TestJoinServer_Banned_RejectedBeforeAnything(t *testing.T) {
	inv := &stubInvite{serverID: "s1"}
	sr := &stubServerRepo{server: &models.Server{ID: "s1", ApprovalRequired: true}}
	jr := &stubJoinReqRepo{}
	svc := newTestServerService(sr, &stubBanRepo{banned: true}, jr, inv)

	if _, err := svc.JoinServer(context.Background(), "u1", "code"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("banned join want ErrForbidden, got %v", err)
	}
	if sr.addCalls != 0 || jr.createCalls != 0 || inv.consumeCalls != 0 {
		t.Fatal("banned user must neither join, request, nor consume an invite")
	}
}

func TestApproveRequest_PromotesWithoutConsuming(t *testing.T) {
	inv := &stubInvite{serverID: "s1"}
	sr := &stubServerRepo{server: &models.Server{ID: "s1"}}
	jr := &stubJoinReqRepo{deleteOK: true}
	svc := newTestServerService(sr, &stubBanRepo{}, jr, inv)

	if err := svc.ApproveRequest(context.Background(), "s1", "u1"); err != nil {
		t.Fatalf("approve: %v", err)
	}
	// Two deletes: the atomic claim in ApproveRequest, then the choke-point cleanup inside
	// promoteToMember (a no-op here since the row is already gone).
	if jr.deleteCalls != 2 {
		t.Fatalf("Delete calls = %d, want 2 (claim + post-join cleanup)", jr.deleteCalls)
	}
	if sr.addCalls != 1 {
		t.Fatalf("AddMember calls = %d, want 1", sr.addCalls)
	}
	if inv.consumeCalls != 0 {
		t.Fatal("approval must NOT consume an invite use (admin is the gate)")
	}
}

func TestApproveRequest_NoPendingRequest_NotFound(t *testing.T) {
	sr := &stubServerRepo{server: &models.Server{ID: "s1"}}
	jr := &stubJoinReqRepo{deleteOK: false} // nothing to claim (already handled / never existed)
	svc := newTestServerService(sr, &stubBanRepo{}, jr, &stubInvite{serverID: "s1"})

	if err := svc.ApproveRequest(context.Background(), "s1", "u1"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if sr.addCalls != 0 {
		t.Fatal("no claimed request must not add a member (concurrency safety)")
	}
}

func TestRejectRequest(t *testing.T) {
	jr := &stubJoinReqRepo{deleteOK: true}
	svc := newTestServerService(&stubServerRepo{server: &models.Server{ID: "s1"}}, &stubBanRepo{}, jr, &stubInvite{serverID: "s1"})
	if err := svc.RejectRequest(context.Background(), "s1", "u1"); err != nil {
		t.Fatalf("reject: %v", err)
	}

	jr2 := &stubJoinReqRepo{deleteOK: false}
	svc2 := newTestServerService(&stubServerRepo{server: &models.Server{ID: "s1"}}, &stubBanRepo{}, jr2, &stubInvite{serverID: "s1"})
	if err := svc2.RejectRequest(context.Background(), "s1", "u1"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("reject of already-gone request want ErrNotFound, got %v", err)
	}
}
