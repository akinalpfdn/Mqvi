package services

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

// permWorld is one server with a hidden channel and a member for every role/override combination
// that changes the answer, seeded into the real schema.
type permWorld struct {
	svc     *channelPermService
	channel string
	server  string
	users   []string
	want    map[string]bool // ViewChannel in channel
}

func seedPermWorld(t *testing.T) permWorld {
	t.Helper()
	f := dbtest.New(t)
	serverID := f.Server(dbtest.ServerSeed{})
	channelID := f.Channel("", serverID)

	role := func(id string, perms models.Permission) {
		f.ExecWithoutForeignKeys(
			`INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
			 VALUES (?, ?, ?, '#fff', 1, ?, 0, 0, 1)`, id, serverID, id, perms)
	}
	override := func(roleID string, allow, deny models.Permission) {
		f.ExecWithoutForeignKeys(`INSERT INTO channel_permissions (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)`,
			channelID, roleID, allow, deny)
	}
	member := func(id string, roleIDs ...string) string {
		uid := f.User(id)
		f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, serverID, uid)
		for _, r := range roleIDs {
			f.ExecWithoutForeignKeys(`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, uid, r, serverID)
		}
		return uid
	}

	role("everyone", models.PermViewChannel|models.PermReadMessages)
	role("muted", models.PermReadMessages)
	role("staff", models.PermReadMessages)
	role("admin", models.PermAdmin)
	role("plain", 0)
	override("everyone", 0, models.PermViewChannel) // the channel is hidden from @everyone
	override("staff", models.PermViewChannel, 0)    // and granted back to staff

	w := permWorld{channel: channelID, server: serverID, want: map[string]bool{}}
	add := func(uid string, sees bool) {
		w.users = append(w.users, uid)
		w.want[uid] = sees
	}
	add(member("everyone-only", "everyone"), false)     // base View, denied by override
	add(member("staff-too", "everyone", "staff"), true) // allow beats deny for the same bit
	add(member("staff-only", "staff"), true)            // no base View, granted by override
	add(member("admin", "everyone", "admin"), true)     // Admin bypasses the deny
	add(member("no-view-role", "muted"), false)         // never had View
	add(member("roleless"), false)                      // a member with no roles at all
	add(member("plain-role", "plain"), false)           // a role with no bits
	add(f.User("not-a-member"), false)                  // online elsewhere, not in this server

	w.server = serverID
	w.svc = NewChannelPermissionService(
		repository.NewSQLiteChannelPermRepo(f.DB),
		repository.NewSQLiteRoleRepo(f.DB),
		repository.NewSQLiteChannelRepo(f.DB),
		&testutil.MockBroadcaster{},
	).(*channelPermService)
	return w
}

// The batched filter decides who receives voice events. It must agree, user for user, with the
// resolver every permission gate uses and with the sidebar's visibility filter — otherwise a member
// is shown a channel's participants for a channel the sidebar hides from them, or the reverse.
func TestFilterUsersWithPermission_AgreesWithResolverAndSidebar(t *testing.T) {
	ctx := context.Background()
	w := seedPermWorld(t)

	got, err := w.svc.FilterUsersWithPermission(ctx, w.channel, w.users, models.PermViewChannel)
	if err != nil {
		t.Fatalf("FilterUsersWithPermission: %v", err)
	}
	filtered := make(map[string]bool, len(got))
	for _, uid := range got {
		filtered[uid] = true
	}

	for _, uid := range w.users {
		perms, err := w.svc.ResolveChannelPermissions(ctx, uid, w.channel)
		if err != nil {
			t.Fatalf("ResolveChannelPermissions(%s): %v", uid, err)
		}
		vis, err := w.svc.BuildVisibilityFilter(ctx, uid, w.server)
		if err != nil {
			t.Fatalf("BuildVisibilityFilter(%s): %v", uid, err)
		}
		resolver, sidebar := perms.Has(models.PermViewChannel), vis.CanSee(w.channel)

		if filtered[uid] != w.want[uid] {
			t.Errorf("%s: filter says %v, want %v", uid, filtered[uid], w.want[uid])
		}
		if resolver != filtered[uid] || sidebar != filtered[uid] {
			t.Errorf("%s: filter %v, resolver %v, sidebar %v — the three must agree", uid, filtered[uid], resolver, sidebar)
		}
	}
}

// A multi-bit requirement needs every bit (or Admin), the same rule channelAudience applies.
func TestFilterUsersWithPermission_RequiresEveryBit(t *testing.T) {
	ctx := context.Background()
	w := seedPermWorld(t)

	got, err := w.svc.FilterUsersWithPermission(ctx, w.channel, w.users, models.PermViewChannel|models.PermConnectVoice)
	if err != nil {
		t.Fatalf("FilterUsersWithPermission: %v", err)
	}
	for _, uid := range got {
		perms, _ := w.svc.ResolveChannelPermissions(ctx, uid, w.channel)
		if !hasAllPermissions(perms, models.PermViewChannel|models.PermConnectVoice) {
			t.Errorf("%s passed without ConnectVoice (perms %d)", uid, perms)
		}
	}
	if len(got) != 1 {
		t.Fatalf("got %v, want only the admin — nobody else holds ConnectVoice", got)
	}
}

// The filter answers who receives an event right now; a grant cached before a revoke must not
// keep delivering.
func TestFilterUsersWithPermission_IgnoresTheCache(t *testing.T) {
	ctx := context.Background()
	w := seedPermWorld(t)

	staff := "staff-only"
	if _, err := w.svc.ResolveChannelPermissions(ctx, staff, w.channel); err != nil { // warm the cache
		t.Fatalf("resolve: %v", err)
	}
	if err := w.svc.permRepo.Delete(ctx, w.channel, "staff"); err != nil { // revoke behind the cache's back
		t.Fatalf("delete override: %v", err)
	}

	got, err := w.svc.FilterUsersWithPermission(ctx, w.channel, []string{staff}, models.PermViewChannel)
	if err != nil {
		t.Fatalf("FilterUsersWithPermission: %v", err)
	}
	if len(got) != 0 {
		t.Fatal("a cached grant still let a revoked user receive the channel's events")
	}
}

func TestFilterUsersWithPermission_UnknownChannelIsAnError(t *testing.T) {
	w := seedPermWorld(t)
	if _, err := w.svc.FilterUsersWithPermission(context.Background(), "no-such-channel", w.users, models.PermViewChannel); err == nil {
		t.Fatal("an unknown channel resolved an audience; callers fail closed only on an error")
	}
}
