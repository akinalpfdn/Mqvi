package services

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"sort"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/testutil/dbtest"
	"github.com/akinalp/mqvi/ws"
)

// scopeRecorder records where each event went. ToAll is the leak this suite exists to catch:
// every connected user of the platform, members of the server or not.
type scopeRecorder struct {
	toAll    []ws.Event
	toServer map[string][]ws.Event
	toUsers  []sentToUsers
}

type sentToUsers struct {
	users []string
	event ws.Event
}

func newScopeRecorder() *scopeRecorder { return &scopeRecorder{toServer: map[string][]ws.Event{}} }

func (r *scopeRecorder) BroadcastToAll(e ws.Event)                 { r.toAll = append(r.toAll, e) }
func (r *scopeRecorder) BroadcastToAllExcept(_ string, e ws.Event) { r.toAll = append(r.toAll, e) }
func (r *scopeRecorder) BroadcastToUser(uid string, e ws.Event)    { r.BroadcastToUsers([]string{uid}, e) }
func (r *scopeRecorder) BroadcastToUsers(uids []string, e ws.Event) {
	r.toUsers = append(r.toUsers, sentToUsers{uids, e})
}
func (r *scopeRecorder) BroadcastToServer(sid string, e ws.Event) {
	r.toServer[sid] = append(r.toServer[sid], e)
}
func (r *scopeRecorder) BroadcastToServerExcept(sid, _ string, e ws.Event) {
	r.BroadcastToServer(sid, e)
}

func (r *scopeRecorder) requireOnlyServer(t *testing.T, serverID, op string) {
	t.Helper()
	if len(r.toAll) != 0 {
		t.Fatalf("%d event(s) went to every connected user (first op %q) — server data must stay in the server", len(r.toAll), r.toAll[0].Op)
	}
	for _, e := range r.toServer[serverID] {
		if e.Op == op {
			return
		}
	}
	t.Fatalf("%q was not sent to server %s (got %+v)", op, serverID, r.toServer)
}

func (r *scopeRecorder) usersFor(op string) []string {
	for _, s := range r.toUsers {
		if s.event.Op == op {
			out := append([]string(nil), s.users...)
			sort.Strings(out)
			return out
		}
	}
	return nil
}

type fixedOnline map[string][]string

func (f fixedOnline) GetOnlineUserIDsForServer(serverID string) []string { return f[serverID] }

type permTable map[string]models.Permission // key "user:channel"

func (p permTable) resolver(errUser string) *testutil.MockChannelPermResolver {
	return &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, userID, channelID string) (models.Permission, error) {
			if userID == errUser {
				return 0, errors.New("resolve failed")
			}
			return p[userID+":"+channelID], nil
		},
	}
}

// ─── Static guard ───

// BroadcastToAll reaches users who share no server with the data. It is allowed only where the data
// is platform-wide by nature. A new call anywhere else fails here before it ships.
func TestBroadcastToAll_OnlyForPlatformWideData(t *testing.T) {
	allowed := map[string]bool{
		"badge_service.go": true, // badges are global profile decorations
	}

	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("parse services: %v", err)
	}
	if len(pkgs) == 0 {
		t.Fatal("parsed no packages — the guard checked nothing")
	}
	for _, pkg := range pkgs {
		for path, file := range pkg.Files {
			name := path[strings.LastIndex(path, "/")+1:]
			ast.Inspect(file, func(n ast.Node) bool {
				sel, ok := n.(*ast.SelectorExpr)
				if !ok || (sel.Sel.Name != "BroadcastToAll" && sel.Sel.Name != "BroadcastToAllExcept") {
					return true
				}
				if !allowed[name] {
					t.Errorf("%s: %s calls %s — send server-scoped data with BroadcastToServer or to a filtered user list",
						fset.Position(sel.Pos()), name, sel.Sel.Name)
				}
				return true
			})
		}
	}
}

// ─── channelAudience ───

func TestChannelAudience_KeepsOnlyUsersWithEveryRequiredBit(t *testing.T) {
	online := fixedOnline{"srv": {"reader", "viewonly", "admin", "broken", "none"}}
	perms := permTable{
		"reader:ch":   models.PermViewChannel | models.PermReadMessages,
		"viewonly:ch": models.PermViewChannel,
		"admin:ch":    models.PermAdmin,
	}
	got := channelAudience(context.Background(), online, perms.resolver("broken"), "srv", "ch",
		models.PermViewChannel|models.PermReadMessages)
	sort.Strings(got)
	want := []string{"admin", "reader"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("audience = %v, want %v (one bit is not enough, a resolve error drops the user)", got, want)
	}
}

// ─── Channels ───

type fixedVoice map[string]string

func (f fixedVoice) GetUserVoiceChannelID(userID string) string { return f[userID] }

func TestChannelUpdate_GoesOnlyToMembersWhoSeeTheChannel(t *testing.T) {
	rec := newScopeRecorder()
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv", Name: "staff"}, nil
		},
	}
	online := fixedOnline{"srv": {"viewer", "outsider", "voiceonly"}}
	perms := permTable{"viewer:staff-ch": models.PermViewChannel}
	svc := NewChannelService(channels, nil, rec, nil,
		fixedVoice{"voiceonly": "staff-ch"}, nil, nil, online, perms.resolver(""))

	name := "secret-plans"
	if _, err := svc.Update(context.Background(), "srv", "staff-ch", &models.UpdateChannelRequest{Name: &name}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(rec.toAll) != 0 || len(rec.toServer["srv"]) != 0 {
		t.Fatalf("channel_update was broadcast wide (all=%d server=%d); its name/topic must reach viewers only",
			len(rec.toAll), len(rec.toServer["srv"]))
	}
	got := rec.usersFor(ws.OpChannelUpdate)
	if strings.Join(got, ",") != "viewer,voiceonly" {
		t.Fatalf("channel_update recipients = %v, want [viewer voiceonly] — the sidebar shows a voice channel you sit in", got)
	}
}

func TestChannelDelete_StaysInTheServer(t *testing.T) {
	rec := newScopeRecorder()
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv", Type: models.ChannelTypeText}, nil
		},
	}
	svc := NewChannelService(channels, nil, rec, nil, nil, nil, noopFileCleanup{},
		fixedOnline{}, permTable{}.resolver(""))

	if err := svc.Delete(context.Background(), "srv", "ch1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	rec.requireOnlyServer(t, "srv", ws.OpChannelDelete)
}

// noopFileCleanup: Delete collects and executes a plan; nothing to clean in these tests.
type noopFileCleanup struct{ FileCleanupService }

func (noopFileCleanup) CollectChannelFiles(context.Context, string) (*CleanupPlan, error) {
	return &CleanupPlan{}, nil
}
func (noopFileCleanup) Execute(*CleanupPlan) {}

// ─── Categories ───

func TestCategoryEvents_StayInTheServer(t *testing.T) {
	f := dbtest.New(t)
	srv := f.Server(dbtest.ServerSeed{})
	rec := newScopeRecorder()
	svc := NewCategoryService(repository.NewSQLiteCategoryRepo(f.DB), rec)
	ctx := context.Background()

	cat, err := svc.Create(ctx, srv, &models.CreateCategoryRequest{Name: "Staff"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	rec.requireOnlyServer(t, srv, ws.OpCategoryCreate)

	newName := "Staff Only"
	if _, err := svc.Update(ctx, srv, cat.ID, &models.UpdateCategoryRequest{Name: &newName}); err != nil {
		t.Fatalf("update: %v", err)
	}
	rec.requireOnlyServer(t, srv, ws.OpCategoryUpdate)

	if err := svc.Delete(ctx, srv, cat.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	rec.requireOnlyServer(t, srv, ws.OpCategoryDelete)
}

// ─── Roles ───

func newScopedRoleService(rec *scopeRecorder) RoleService {
	return NewRoleService(
		&testutil.MockRoleRepo{
			GetByUserIDAndServerFn: func(context.Context, string, string) ([]models.Role, error) {
				return []models.Role{{ID: "owner", ServerID: "srv", IsOwner: true, Position: 100, Permissions: models.PermAll}}, nil
			},
			GetByIDFn: func(_ context.Context, id string) (*models.Role, error) {
				return &models.Role{ID: id, ServerID: "srv", Position: 5}, nil
			},
		},
		&testutil.MockUserRepo{},
		rec,
	)
}

func TestRoleEvents_StayInTheServer(t *testing.T) {
	ctx := context.Background()

	rec := newScopeRecorder()
	if _, err := newScopedRoleService(rec).Create(ctx, "srv", "actor", &models.CreateRoleRequest{Name: "Mods", Color: "#ffffff"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	rec.requireOnlyServer(t, "srv", ws.OpRoleCreate)

	rec = newScopeRecorder()
	if err := newScopedRoleService(rec).Delete(ctx, "srv", "actor", "r5"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	rec.requireOnlyServer(t, "srv", ws.OpRoleDelete)

	rec = newScopeRecorder()
	if _, err := newScopedRoleService(rec).ReorderRoles(ctx, "srv", "actor", []models.PositionUpdate{{ID: "r5", Position: 3}}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	rec.requireOnlyServer(t, "srv", ws.OpRolesReorder)
}

// ─── Channel permission overrides ───

func TestOverrideEvents_StayInTheServer(t *testing.T) {
	ctx := context.Background()
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv"}, nil
		},
	}

	rec := newScopeRecorder()
	svc := NewChannelPermissionService(&testutil.MockChannelPermRepo{}, &testutil.MockRoleRepo{}, channels, rec)
	if err := svc.SetOverride(ctx, "srv", "ch1", "r1", &models.SetOverrideRequest{Deny: models.PermViewChannel}); err != nil {
		t.Fatalf("set: %v", err)
	}
	rec.requireOnlyServer(t, "srv", ws.OpChannelPermissionUpdate)

	rec = newScopeRecorder()
	svc = NewChannelPermissionService(&testutil.MockChannelPermRepo{}, &testutil.MockRoleRepo{}, channels, rec)
	if err := svc.DeleteOverride(ctx, "srv", "ch1", "r1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	rec.requireOnlyServer(t, "srv", ws.OpChannelPermissionDelete)
}

// ─── E2EE group sessions ───

type nopGroupSessionRepo struct{}

func (nopGroupSessionRepo) Upsert(context.Context, string, string, string, *models.CreateGroupSessionRequest) error {
	return nil
}
func (nopGroupSessionRepo) GetByChannel(context.Context, string) ([]models.ChannelGroupSession, error) {
	return nil, nil
}
func (nopGroupSessionRepo) DeleteByChannel(context.Context, string) error      { return nil }
func (nopGroupSessionRepo) DeleteByUser(context.Context, string, string) error { return nil }

func TestGroupSessionNew_GoesOnlyToTheChannelsReaders(t *testing.T) {
	rec := newScopeRecorder()
	read := models.PermViewChannel | models.PermReadMessages
	perms := permTable{"sender:enc": read, "reader:enc": read, "viewonly:enc": models.PermViewChannel}
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv"}, nil
		},
	}
	svc := NewE2EEService(nil, nopGroupSessionRepo{}, perms.resolver(""), rec, channels,
		fixedOnline{"srv": {"sender", "reader", "viewonly", "stranger"}})

	err := svc.UpsertGroupSession(context.Background(), "enc", "sender", "dev1",
		&models.CreateGroupSessionRequest{SessionID: "s1", SessionData: "opaque"})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if len(rec.toAll) != 0 {
		t.Fatal("group_session_new went to every connected user — it says who is active in which encrypted channel")
	}
	got := rec.usersFor(ws.OpGroupSessionNew)
	if strings.Join(got, ",") != "reader,sender" {
		t.Fatalf("group_session_new recipients = %v, want [reader sender]", got)
	}
}
