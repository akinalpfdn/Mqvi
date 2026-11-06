package services

import (
	"context"
	"errors"
	"fmt"
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

// tableFilter is the batch audience read over a permTable: Admin holds everything, as in
// foldChannelPermissions. calls counts reads, so a test can see the read is one per event.
type tableFilter struct {
	table permTable
	fail  bool
	calls int
}

func (p permTable) filter(fail bool) *tableFilter { return &tableFilter{table: p, fail: fail} }

func (f *tableFilter) FilterUsersWithPermission(_ context.Context, channelID string, userIDs []string, required models.Permission) ([]string, error) {
	f.calls++
	if f.fail {
		return nil, errors.New("read failed")
	}
	var out []string
	for _, uid := range userIDs {
		perms := f.table[uid+":"+channelID]
		if perms.Has(models.PermAdmin) || perms&required == required {
			out = append(out, uid)
		}
	}
	return out, nil
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
	online := fixedOnline{"srv": {"reader", "viewonly", "admin", "none"}}
	perms := permTable{
		"reader:ch":   models.PermViewChannel | models.PermReadMessages,
		"viewonly:ch": models.PermViewChannel,
		"admin:ch":    models.PermAdmin,
	}
	got := channelAudience(context.Background(), online, perms.filter(false), "srv", "ch",
		models.PermViewChannel|models.PermReadMessages)
	sort.Strings(got)
	want := []string{"admin", "reader"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("audience = %v, want %v (one bit is not enough)", got, want)
	}
}

// One read for the whole server: per member it was ~3 queries each, thousands for one event.
func TestChannelAudience_ReadsPermissionsOncePerEvent(t *testing.T) {
	members := make([]string, 1000)
	for i := range members {
		members[i] = fmt.Sprintf("u%d", i)
	}
	filter := permTable{}.filter(false)

	channelAudience(context.Background(), fixedOnline{"srv": members}, filter, "srv", "ch", models.PermViewChannel)

	if filter.calls != 1 {
		t.Fatalf("permission reads = %d for 1000 members, want 1", filter.calls)
	}
}

func TestChannelAudience_TellsNobodyWhenThePermissionReadFails(t *testing.T) {
	online := fixedOnline{"srv": {"reader", "admin"}}
	perms := permTable{"reader:ch": models.PermViewChannel, "admin:ch": models.PermAdmin}

	got := channelAudience(context.Background(), online, perms.filter(true), "srv", "ch", models.PermViewChannel)

	if len(got) != 0 {
		t.Fatalf("audience = %v on a failed read, want nobody — withheld, not leaked", got)
	}
}

func TestChannelAudience_NoReadForAnEmptyServer(t *testing.T) {
	filter := permTable{}.filter(false)

	if got := channelAudience(context.Background(), fixedOnline{}, filter, "srv", "ch", models.PermViewChannel); len(got) != 0 || filter.calls != 0 {
		t.Fatalf("audience %v, reads %d, want none of either", got, filter.calls)
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
		fixedVoice{"voiceonly": "staff-ch"}, nil, nil, online, perms.filter(false))

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

// A hidden channel's id is not for members who never saw it, deleted or not. The audience is read
// before the delete: afterwards the overrides are gone and everyone would read as a viewer.
func TestChannelDelete_GoesOnlyToMembersWhoSawTheChannel(t *testing.T) {
	rec := newScopeRecorder()
	perms := permTable{"viewer:staff-ch": models.PermViewChannel}
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv", Type: models.ChannelTypeText}, nil
		},
		DeleteFn: func(context.Context, string) error {
			perms["outsider:staff-ch"] = models.PermViewChannel // overrides gone: everyone "sees" it
			return nil
		},
	}
	online := fixedOnline{"srv": {"viewer", "outsider", "voiceonly"}}
	svc := NewChannelService(channels, nil, rec, nil, fixedVoice{"voiceonly": "staff-ch"}, nil, noopFileCleanup{},
		online, perms.filter(false))

	if err := svc.Delete(context.Background(), "srv", "staff-ch"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(rec.toAll) != 0 || len(rec.toServer["srv"]) != 0 {
		t.Fatalf("channel_delete was broadcast wide (all=%d server=%d)", len(rec.toAll), len(rec.toServer["srv"]))
	}
	if got := rec.usersFor(ws.OpChannelDelete); strings.Join(got, ",") != "viewer,voiceonly" {
		t.Fatalf("channel_delete recipients = %v, want [viewer voiceonly]", got)
	}
}

// A failed read tells the whole server: a deleted channel's id is worth less than a channel stuck in
// every sidebar. Never every connected client.
func TestChannelDelete_AFailedReadTellsTheServer(t *testing.T) {
	rec := newScopeRecorder()
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv", Type: models.ChannelTypeText}, nil
		},
	}
	svc := NewChannelService(channels, nil, rec, nil, nil, nil, noopFileCleanup{},
		fixedOnline{"srv": {"viewer"}}, permTable{}.filter(true))

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

// Who saw the channel cannot be read here (no online source): the whole server is told, never every
// connected client. The scoped audience is tested against the real schema in
// channel_permission_filter_test.go.
func TestOverrideEvents_AFailedReadStaysInTheServer(t *testing.T) {
	ctx := context.Background()
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv"}, nil
		},
	}

	rec := newScopeRecorder()
	svc := NewChannelPermissionService(&testutil.MockChannelPermRepo{}, &testutil.MockRoleRepo{}, channels, rec, nil)
	if err := svc.SetOverride(ctx, "srv", "ch1", "r1", &models.SetOverrideRequest{Deny: models.PermViewChannel}); err != nil {
		t.Fatalf("set: %v", err)
	}
	rec.requireOnlyServer(t, "srv", ws.OpChannelPermissionUpdate)

	rec = newScopeRecorder()
	svc = NewChannelPermissionService(&testutil.MockChannelPermRepo{}, &testutil.MockRoleRepo{}, channels, rec, nil)
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
		fixedOnline{"srv": {"sender", "reader", "viewonly", "stranger"}}, perms.filter(false))

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
