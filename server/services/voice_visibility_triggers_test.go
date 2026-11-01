package services

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"strings"
	"sync"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
)

// voiceHooks records the voice calls a permission or membership change makes.
type voiceHooks struct {
	mu          sync.Mutex
	channelSync []string // serverID/channelID
	serverSync  []string
	userSync    []string // serverID/userID
	leftServer  []string // userID@serverID
}

func (v *voiceHooks) record(list *[]string, entry string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	*list = append(*list, entry)
}

func (v *voiceHooks) EnforceChannelVoicePermissions(string) {}
func (v *voiceHooks) EnforceServerVoicePermissions(string)  {}
func (v *voiceHooks) EnforceUserVoicePermissions(string)    {}
func (v *voiceHooks) ResyncChannelVisibility(serverID, channelID string) {
	v.record(&v.channelSync, serverID+"/"+channelID)
}
func (v *voiceHooks) ResyncServerVisibility(serverID string) { v.record(&v.serverSync, serverID) }
func (v *voiceHooks) ResyncUserVisibility(serverID, userID string) {
	v.record(&v.userSync, serverID+"/"+userID)
}
func (v *voiceHooks) DisconnectUserFromServer(userID, serverID string) bool {
	v.record(&v.leftServer, userID+"@"+serverID)
	return true
}
func (v *voiceHooks) GetServerParticipants(string) []models.VoiceState { return nil }

func requireOnly(t *testing.T, what string, got []string, want string) {
	t.Helper()
	if len(got) != 1 || got[0] != want {
		t.Fatalf("%s = %v, want exactly [%s]", what, got, want)
	}
}

// ─── Channel overrides ───

func overrideService(hooks *voiceHooks) ChannelPermissionService {
	svc := newTestChannelPermService(
		&testutil.MockChannelPermRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv"}, nil
		}},
		&testutil.MockBroadcaster{},
	)
	svc.SetVoiceEnforcer(hooks)
	return svc
}

// Every way an override changes must resend the server's members what they may now see — a revoke
// that skipped it would leave the hidden channel's participants on screen.
func TestOverrideChanges_ResyncVoiceVisibility(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		call func(ChannelPermissionService) error
	}{
		{"set", func(s ChannelPermissionService) error {
			return s.SetOverride(ctx, "srv", "vc", "role", &models.SetOverrideRequest{Deny: models.PermViewChannel})
		}},
		{"set to inherit (delete branch)", func(s ChannelPermissionService) error {
			return s.SetOverride(ctx, "srv", "vc", "role", &models.SetOverrideRequest{})
		}},
		{"delete", func(s ChannelPermissionService) error { return s.DeleteOverride(ctx, "srv", "vc", "role") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hooks := &voiceHooks{}
			if err := tc.call(overrideService(hooks)); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			requireOnly(t, "channel resyncs", hooks.channelSync, "srv/vc")
		})
	}
}

// ─── Roles ───

func TestRolePermissionChanges_ResyncVoiceVisibility(t *testing.T) {
	ctx := context.Background()
	perms := models.PermViewChannel
	name := "renamed"

	hooks := &voiceHooks{}
	svc := newScopedRoleService(newScopeRecorder())
	svc.SetVoiceEnforcer(hooks)

	if _, err := svc.Update(ctx, "srv", "actor", "r1", &models.UpdateRoleRequest{Name: &name}); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if len(hooks.serverSync) != 0 {
		t.Fatalf("a rename resynced voice visibility: %v", hooks.serverSync)
	}

	if _, err := svc.Update(ctx, "srv", "actor", "r1", &models.UpdateRoleRequest{Permissions: &perms}); err != nil {
		t.Fatalf("permission edit: %v", err)
	}
	requireOnly(t, "server resyncs after a permission edit", hooks.serverSync, "srv")

	hooks.serverSync = nil
	if err := svc.Delete(ctx, "srv", "actor", "r1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	requireOnly(t, "server resyncs after a delete", hooks.serverSync, "srv")
}

// ─── Members ───

type memberServerRepo struct {
	repository.ServerRepository
	server  *models.Server
	removed []string
}

func (r *memberServerRepo) GetByID(context.Context, string) (*models.Server, error) {
	return r.server, nil
}
func (r *memberServerRepo) RemoveMember(_ context.Context, serverID, userID string) error {
	r.removed = append(r.removed, userID+"@"+serverID)
	return nil
}

func hierarchyRoles() *testutil.MockRoleRepo {
	return &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, userID, serverID string) ([]models.Role, error) {
			if userID == "actor" {
				return []models.Role{{ID: "mod", ServerID: serverID, Position: 10}}, nil
			}
			return []models.Role{{ID: "base", ServerID: serverID, Position: 1, IsDefault: true}}, nil
		},
		GetByIDFn: func(_ context.Context, id string) (*models.Role, error) {
			return &models.Role{ID: id, ServerID: "srv", Position: 5}, nil
		},
	}
}

func memberUnderTest(hooks *voiceHooks) *memberService {
	return &memberService{
		roleRepo: hierarchyRoles(),
		userRepo: &testutil.MockUserRepo{
			GetActiveByIDFn: func(_ context.Context, id string) (*models.User, error) { return &models.User{ID: id}, nil },
			GetByIDFn:       func(_ context.Context, id string) (*models.User, error) { return &models.User{ID: id}, nil },
		},
		serverRepo:    &memberServerRepo{server: &models.Server{ID: "srv"}},
		hub:           &testutil.MockEventPublisher{},
		voiceKick:     hooks,
		urlSigner:     stubSigner{},
		voiceEnforcer: hooks,
	}
}

func TestModifyRoles_ResyncsTheMembersVoiceVisibility(t *testing.T) {
	hooks := &voiceHooks{}
	if _, err := memberUnderTest(hooks).ModifyRoles(context.Background(), "srv", "actor", "target", []string{"r-new"}); err != nil {
		t.Fatalf("ModifyRoles: %v", err)
	}
	requireOnly(t, "user resyncs", hooks.userSync, "srv/target")
}

// Kick and ban end the member's call on this server only.
func TestKickAndBan_DisconnectOnlyThisServersVoice(t *testing.T) {
	ctx := context.Background()

	hooks := &voiceHooks{}
	if err := memberUnderTest(hooks).Kick(ctx, "srv", "actor", "target"); err != nil {
		t.Fatalf("Kick: %v", err)
	}
	requireOnly(t, "kick voice disconnects", hooks.leftServer, "target@srv")

	hooks = &voiceHooks{}
	m := memberUnderTest(hooks)
	m.banRepo = banRepoAccepting{}
	if err := m.Ban(ctx, "srv", "actor", "target", "spam"); err != nil {
		t.Fatalf("Ban: %v", err)
	}
	requireOnly(t, "ban voice disconnects", hooks.leftServer, "target@srv")
}

type banRepoAccepting struct{ repository.BanRepository }

func (banRepoAccepting) Create(context.Context, *models.Ban) error { return nil }

// ─── Leaving a server ───

type invalidations struct{ users []string }

func (i *invalidations) InvalidateUserPermissions(userID string) { i.users = append(i.users, userID) }
func (i *invalidations) InvalidateAllPermissions()               {}

// Leaving is a client request. A client that leaves without hanging up must still be taken out of
// that server's call, or it stays a participant and keeps receiving the channel's events.
func TestLeaveServer_EndsTheCallOnThatServerAndDropsCachedPermissions(t *testing.T) {
	hooks := &voiceHooks{}
	inv := &invalidations{}
	repo := &memberServerRepo{server: &models.Server{ID: "srv", OwnerID: "owner"}}
	svc := &serverService{serverRepo: repo, hub: &testutil.MockEventPublisher{}, voiceDisc: hooks, permInvalidator: inv}

	if err := svc.LeaveServer(context.Background(), "srv", "leaver"); err != nil {
		t.Fatalf("LeaveServer: %v", err)
	}
	requireOnly(t, "voice disconnects", hooks.leftServer, "leaver@srv")
	requireOnly(t, "permission invalidations", inv.users, "leaver")
}

// Who may see a voice channel changes when an override, a role's permissions or a member's roles
// are written. Each of those writes must be followed by a voice resync, or members keep — or never
// get — the participants of channels whose visibility changed. This finds every function in the
// package that writes one, so a new write path without a resync turns this red.
func TestPermissionWrites_ResyncVoiceVisibility(t *testing.T) {
	writes := map[string]map[string]bool{ // receiver field → write methods
		"permRepo":   {"Set": true, "Delete": true, "DeleteAllByChannel": true},
		"roleRepo":   {"Update": true, "Delete": true, "AssignToUser": true, "RemoveFromUser": true},
		"txRoleRepo": {"Update": true, "Delete": true, "AssignToUser": true, "RemoveFromUser": true},
	}
	resyncs := func(name string) bool {
		return strings.HasPrefix(name, "Resync") || name == "SyncServerStatesToUser" ||
			name == "enforceChannelVoice" || name == "enforceServerVoice" // both call a Resync, tested above
	}
	exempt := map[string]string{
		"CreateServer": "a new server has nobody in voice",
	}

	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool { return !strings.HasSuffix(fi.Name(), "_test.go") }, 0)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	found := 0
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				var writeAt token.Pos
				hasResync := false
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					sel, ok := call.Fun.(*ast.SelectorExpr)
					if !ok {
						return true
					}
					if resyncs(sel.Sel.Name) {
						hasResync = true
					}
					recv := ""
					switch x := sel.X.(type) {
					case *ast.SelectorExpr:
						recv = x.Sel.Name
					case *ast.Ident:
						recv = x.Name
					}
					if writes[recv][sel.Sel.Name] && writeAt == token.NoPos {
						writeAt = sel.Pos()
					}
					return true
				})
				if writeAt == token.NoPos {
					continue
				}
				found++
				if _, ok := exempt[fn.Name.Name]; ok || hasResync {
					continue
				}
				t.Errorf("%s writes permissions at %s without a voice resync", fn.Name.Name, fset.Position(writeAt))
			}
		}
	}
	if found < 6 {
		t.Fatalf("found only %d permission-writing functions — the scan is not seeing them", found)
	}
}

type channelDisconnects struct {
	participants []models.VoiceState
	left         []string // userID@channelID
}

func (c *channelDisconnects) GetChannelParticipants(string) []models.VoiceState {
	return c.participants
}
func (c *channelDisconnects) DisconnectUserFromChannel(userID, channelID string) bool {
	c.left = append(c.left, userID+"@"+channelID)
	return true
}

// Deleting a voice channel disconnects its participants from that channel only: one who moved on
// between the listing and the disconnect is in another call now.
func TestChannelDelete_DisconnectsFromThatChannelOnly(t *testing.T) {
	disc := &channelDisconnects{participants: []models.VoiceState{{UserID: "u1", ChannelID: "vc"}, {UserID: "u2", ChannelID: "vc"}}}
	svc := &channelService{
		channelRepo: &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv", Type: models.ChannelTypeVoice}, nil
		}},
		hub:         &testutil.MockBroadcaster{},
		voiceDisc:   disc,
		fileCleanup: noopFileCleanup{},
	}

	if err := svc.Delete(context.Background(), "srv", "vc"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(disc.left) != 2 || disc.left[0] != "u1@vc" || disc.left[1] != "u2@vc" {
		t.Fatalf("disconnects %v, want both participants from vc only", disc.left)
	}
}
