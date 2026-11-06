package services

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/testutil/dbtest"
	"github.com/akinalp/mqvi/ws"
)

// Permission checks that loop over many channels for one user, or many users for one channel,
// resolve in a fixed number of queries — and must answer exactly what the single resolver answers.

// countingRepos counts the queries a permission resolution makes.
type countingRoles struct {
	repository.RoleRepository
	calls *int
}

func (c countingRoles) GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error) {
	*c.calls++
	return c.RoleRepository.GetByUserIDAndServer(ctx, userID, serverID)
}

type countingOverrides struct {
	repository.ChannelPermissionRepository
	calls *int
}

func (c countingOverrides) GetByRoles(ctx context.Context, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	*c.calls++
	return c.ChannelPermissionRepository.GetByRoles(ctx, roleIDs)
}

func (c countingOverrides) GetByChannelAndRoles(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	*c.calls++
	return c.ChannelPermissionRepository.GetByChannelAndRoles(ctx, channelID, roleIDs)
}

type countingChannels struct {
	repository.ChannelRepository
	calls *int
}

func (c countingChannels) GetByID(ctx context.Context, id string) (*models.Channel, error) {
	*c.calls++
	return c.ChannelRepository.GetByID(ctx, id)
}

// batchWorld is one server with channels covering every override shape and a member for every role
// combination, in the real schema.
type batchWorld struct {
	f        *dbtest.Fixture
	server   string
	channels []string
	users    []string
}

func seedBatchWorld(t *testing.T, extraChannels int) batchWorld {
	t.Helper()
	f := dbtest.New(t)
	w := batchWorld{f: f, server: f.Server(dbtest.ServerSeed{})}
	hidden := f.Channel("", w.server)    // hidden from @everyone, granted back to staff
	plain := f.Channel("", w.server)     // no overrides at all
	noRead := f.Channel("", w.server)    // @everyone may see but not read
	openMuted := f.Channel("", w.server) // a role without View is granted it here
	w.channels = []string{hidden, plain, noRead, openMuted}
	for range extraChannels {
		w.channels = append(w.channels, f.Channel("", w.server))
	}

	role := func(id string, perms models.Permission) {
		f.ExecWithoutForeignKeys(
			`INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
			 VALUES (?, ?, ?, '#fff', 1, ?, 0, 0, 1)`, id, w.server, id, perms)
	}
	override := func(channelID, roleID string, allow, deny models.Permission) {
		f.ExecWithoutForeignKeys(`INSERT INTO channel_permissions (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)`,
			channelID, roleID, allow, deny)
	}
	member := func(id string, roleIDs ...string) {
		uid := f.User(id)
		f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, w.server, uid)
		for _, r := range roleIDs {
			f.ExecWithoutForeignKeys(`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, uid, r, w.server)
		}
		w.users = append(w.users, uid)
	}

	role("everyone", models.PermViewChannel|models.PermReadMessages)
	role("muted", models.PermReadMessages)
	role("staff", models.PermReadMessages)
	role("admin", models.PermAdmin)
	role("plain", 0)
	override(hidden, "everyone", 0, models.PermViewChannel)
	override(hidden, "staff", models.PermViewChannel, 0)
	override(noRead, "everyone", 0, models.PermReadMessages)
	override(openMuted, "muted", models.PermViewChannel, 0)

	member("everyone-only", "everyone")
	member("staff-too", "everyone", "staff")
	member("staff-only", "staff")
	member("admin", "everyone", "admin")
	member("muted", "muted")
	member("roleless")
	member("plain-role", "plain")
	w.users = append(w.users, f.User("not-a-member"))
	return w
}

func (w batchWorld) service(roles, overrides, channels *int) *channelPermService {
	var r repository.RoleRepository = repository.NewSQLiteRoleRepo(w.f.DB)
	var o repository.ChannelPermissionRepository = repository.NewSQLiteChannelPermRepo(w.f.DB)
	var c repository.ChannelRepository = repository.NewSQLiteChannelRepo(w.f.DB)
	if roles != nil {
		r = countingRoles{r, roles}
		o = countingOverrides{o, overrides}
		c = countingChannels{c, channels}
	}
	return NewChannelPermissionService(o, r, c, &testutil.MockBroadcaster{}, nil).(*channelPermService)
}

// The one formula: every user, every channel, the batch answers what the single resolver answers.
func TestResolveUserChannelsPermissions_AgreesWithTheSingleResolver(t *testing.T) {
	ctx := context.Background()
	w := seedBatchWorld(t, 0)
	svc := w.service(nil, nil, nil)

	for _, uid := range w.users {
		svc.InvalidateAllPermissions()
		got, err := svc.ResolveUserChannelsPermissions(ctx, uid, w.server, w.channels)
		if err != nil {
			t.Fatalf("%s: batch: %v", uid, err)
		}
		for _, ch := range w.channels {
			svc.InvalidateAllPermissions()
			want, err := svc.ResolveChannelPermissions(ctx, uid, ch)
			if err != nil {
				t.Fatalf("%s/%s: single: %v", uid, ch, err)
			}
			if got[ch] != want {
				t.Errorf("%s in %s: batch %b, single %b", uid, ch, got[ch], want)
			}
		}
	}
}

func TestResolveUserChannelsPermissions_TwoQueriesForAnyNumberOfChannels(t *testing.T) {
	ctx := context.Background()
	for _, extra := range []int{0, 50} {
		w := seedBatchWorld(t, extra)
		var roles, overrides, channels int
		svc := w.service(&roles, &overrides, &channels)

		if _, err := svc.ResolveUserChannelsPermissions(ctx, w.users[1], w.server, w.channels); err != nil {
			t.Fatal(err)
		}
		if roles+overrides+channels != 2 {
			t.Fatalf("%d channels: %d role, %d override, %d channel queries — want 2 in all",
				len(w.channels), roles, overrides, channels)
		}
	}
}

// failOnSingle is a resolver whose per-channel form must not be used.
func failOnSingle(t *testing.T) func(context.Context, string, string) (models.Permission, error) {
	return func(_ context.Context, userID, channelID string) (models.Permission, error) {
		t.Errorf("resolved %s in %s one by one", userID, channelID)
		return 0, nil
	}
}

type searchChannels []models.Channel

func (c searchChannels) GetAllByServer(context.Context, string) ([]models.Channel, error) {
	return c, nil
}

type recordingSearch struct{ channelIDs []string }

func (r *recordingSearch) Search(_ context.Context, _, _ string, channelIDs []string, _, _ int) (*repository.SearchResult, error) {
	r.channelIDs = channelIDs
	return &repository.SearchResult{}, nil
}

func TestSearch_ResolvesEveryChannelInOneBatch(t *testing.T) {
	batches := 0
	perms := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: failOnSingle(t),
		ResolveUserChannelsPermissionsFn: func(_ context.Context, _, _ string, ids []string) (map[string]models.Permission, error) {
			batches++
			return map[string]models.Permission{
				"readable": models.PermViewChannel | models.PermReadMessages,
				"seen":     models.PermViewChannel,
			}, nil
		},
	}
	repo := &recordingSearch{}
	svc := NewSearchService(repo, searchChannels{{ID: "readable"}, {ID: "seen"}, {ID: "hidden"}}, perms, &testutil.MockFileURLSigner{})

	if _, err := svc.Search(context.Background(), "u1", "srv1", "hello", nil, 25, 0); err != nil {
		t.Fatal(err)
	}
	if batches != 1 || !slices.Equal(repo.channelIDs, []string{"readable"}) {
		t.Fatalf("%d batches, searched %v — want one batch and only the readable channel", batches, repo.channelIDs)
	}

	perms.ResolveUserChannelsPermissionsFn = func(context.Context, string, string, []string) (map[string]models.Permission, error) {
		return nil, errors.New("database is locked")
	}
	if _, err := svc.Search(context.Background(), "u1", "srv1", "hello", nil, 25, 0); err == nil {
		t.Fatal("a failed permission read searched anyway — it must fail closed")
	}
}

// A failed read is an error, not a server with nothing unread.
func TestUnreadCounts_OneBatchAndAFailedReadIsAnError(t *testing.T) {
	repo := &testutil.MockReadStateRepo{
		GetUnreadCountsFn: func(context.Context, string, string) ([]models.UnreadInfo, error) {
			return []models.UnreadInfo{{ChannelID: "readable", UnreadCount: 3}, {ChannelID: "hidden", UnreadCount: 9}}, nil
		},
	}
	batches := 0
	perms := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: failOnSingle(t),
		ResolveUserChannelsPermissionsFn: func(_ context.Context, _, _ string, ids []string) (map[string]models.Permission, error) {
			batches++
			return map[string]models.Permission{"readable": models.PermViewChannel | models.PermReadMessages}, nil
		},
	}
	svc := NewReadStateService(repo, perms)

	got, err := svc.GetUnreadCounts(context.Background(), "u1", "srv1")
	if err != nil || batches != 1 || len(got) != 1 || got[0].ChannelID != "readable" {
		t.Fatalf("got %+v, %v after %d batches — want only the readable channel, one batch", got, err, batches)
	}

	perms.ResolveUserChannelsPermissionsFn = func(context.Context, string, string, []string) (map[string]models.Permission, error) {
		return nil, errors.New("database is locked")
	}
	if got, err := svc.GetUnreadCounts(context.Background(), "u1", "srv1"); err == nil {
		t.Fatalf("a failed read returned %+v as if nothing were unread", got)
	}
}

// A message event reaches its readers through one batched read, never one read per online member.
func TestMessageAudience_OneBatchForEveryOnlineMember(t *testing.T) {
	var got []string
	hub := &testutil.MockBroadcastAndOnline{
		MockBroadcaster: testutil.MockBroadcaster{
			BroadcastToUsersFn: func(users []string, _ ws.Event) { got = users },
		},
		GetOnlineUserIDsForServerFn: func(string) []string { return []string{"reader", "outsider", "other"} },
	}
	batches := 0
	perms := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: failOnSingle(t),
		FilterUsersWithPermissionFn: func(_ context.Context, _ string, users []string, required models.Permission) ([]string, error) {
			batches++
			if required != models.PermViewChannel|models.PermReadMessages {
				t.Errorf("audience asked for %b", required)
			}
			return []string{"reader"}, nil
		},
	}
	channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: "srv1"}, nil
	}}
	svc := NewMessageService(
		&testutil.MockMessageRepo{}, &testutil.MockAttachmentRepo{}, channels, &testutil.MockUserRepo{},
		&testutil.MockMentionRepo{}, &testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{}, &testutil.MockReactionRepo{}, &testutil.MockReadStateRepo{},
		hub, perms, markingSigner{}, &testutil.MockFileDeleter{}, &testutil.MockStorageService{},
		stubServerEncryption{},
	)

	svc.BroadcastCreate(&models.Message{ID: "m1", ChannelID: "ch1"})

	if batches != 1 || !slices.Equal(got, []string{"reader"}) {
		t.Fatalf("%d batches, sent to %v — want one batch and only the reader", batches, got)
	}
}

// A channel or audience that cannot be read withholds the event: guessing whom to tell is a leak.
func TestReadersOf_AnUnreadableChannelOrAudienceWithholdsTheEvent(t *testing.T) {
	online := &testutil.MockBroadcastAndOnline{GetOnlineUserIDsForServerFn: func(string) []string { return []string{"u1"} }}
	allowAll := &testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
		return models.PermAll, nil
	}}
	brokenChannel := &testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
		return nil, errors.New("database is locked")
	}}
	if got := readersOf(brokenChannel, online, allowAll, "ch1"); got != nil {
		t.Fatalf("channel unreadable, told %v", got)
	}

	channel := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: "srv1"}, nil
	}}
	brokenFilter := &testutil.MockChannelPermResolver{
		FilterUsersWithPermissionFn: func(context.Context, string, []string, models.Permission) ([]string, error) {
			return nil, errors.New("database is locked")
		},
	}
	if got := readersOf(channel, online, brokenFilter, "ch1"); got != nil {
		t.Fatalf("audience unreadable, told %v", got)
	}
}
