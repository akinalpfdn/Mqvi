package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

func TestGuide_StepsComeFromTheUsersOwnData(t *testing.T) {
	tests := []struct {
		name string
		// seed gives "me" (and possibly others) some history.
		seed func(f *dbtest.Fixture, me, other string)
		want models.GuideSteps
	}{
		{
			name: "a new account has done nothing",
			seed: func(*dbtest.Fixture, string, string) {},
			want: models.GuideSteps{},
		},
		{
			name: "joining a server is a community",
			seed: func(f *dbtest.Fixture, me, other string) {
				s := f.Server(dbtest.ServerSeed{OwnerID: other})
				f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, s, me)
			},
			want: models.GuideSteps{Community: true},
		},
		{
			name: "a sent channel message",
			seed: func(f *dbtest.Fixture, me, _ string) {
				f.Message(dbtest.MessageSeed{UserID: me, Content: dbtest.Ptr("hi")})
			},
			want: models.GuideSteps{Message: true},
		},
		{
			name: "having joined voice",
			seed: func(f *dbtest.Fixture, me, _ string) {
				f.ExecWithoutForeignKeys(`UPDATE users SET last_voice_activity = CURRENT_TIMESTAMP WHERE id = ?`, me)
			},
			want: models.GuideSteps{Voice: true},
		},
		{
			name: "a friend request I sent",
			seed: func(f *dbtest.Fixture, me, other string) {
				f.ExecWithoutForeignKeys(`INSERT INTO friendships (id, user_id, friend_id, status) VALUES ('f1', ?, ?, 'pending')`, me, other)
			},
			want: models.GuideSteps{Friend: true},
		},
		{
			name: "a friendship someone else started and I accepted",
			seed: func(f *dbtest.Fixture, me, other string) {
				f.ExecWithoutForeignKeys(`INSERT INTO friendships (id, user_id, friend_id, status) VALUES ('f1', ?, ?, 'accepted')`, other, me)
			},
			want: models.GuideSteps{Friend: true},
		},
		{
			name: "a request someone sent me that I have not accepted is not mine",
			seed: func(f *dbtest.Fixture, me, other string) {
				f.ExecWithoutForeignKeys(`INSERT INTO friendships (id, user_id, friend_id, status) VALUES ('f1', ?, ?, 'pending')`, other, me)
			},
			want: models.GuideSteps{},
		},
		{
			name: "blocking someone is not a friend",
			seed: func(f *dbtest.Fixture, me, other string) {
				f.ExecWithoutForeignKeys(`INSERT INTO friendships (id, user_id, friend_id, status) VALUES ('f1', ?, ?, 'blocked')`, me, other)
			},
			want: models.GuideSteps{},
		},
		{
			name: "an avatar",
			seed: func(f *dbtest.Fixture, me, _ string) {
				f.ExecWithoutForeignKeys(`UPDATE users SET avatar_url = '/api/files/a.png' WHERE id = ?`, me)
			},
			want: models.GuideSteps{Profile: true},
		},
		{
			name: "a role I made in my own server",
			seed: func(f *dbtest.Fixture, me, _ string) {
				s := f.Server(dbtest.ServerSeed{OwnerID: me})
				f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, s, me)
				f.ExecWithoutForeignKeys(`INSERT INTO roles (id, server_id, name, is_default, is_owner) VALUES
					('r-everyone', ?, 'everyone', 1, 0), ('r-owner', ?, 'Owner', 0, 1), ('r-mod', ?, 'Mod', 0, 0)`, s, s, s)
			},
			want: models.GuideSteps{Community: true, Roles: true},
		},
		{
			name: "the built-in roles of a new server are not a role I made",
			seed: func(f *dbtest.Fixture, me, _ string) {
				s := f.Server(dbtest.ServerSeed{OwnerID: me})
				f.ExecWithoutForeignKeys(`INSERT INTO roles (id, server_id, name, is_default, is_owner) VALUES
					('r-everyone', ?, 'everyone', 1, 0), ('r-owner', ?, 'Owner', 0, 1)`, s, s)
			},
			want: models.GuideSteps{},
		},
		{
			name: "a role in someone else's server is not mine",
			seed: func(f *dbtest.Fixture, _, other string) {
				s := f.Server(dbtest.ServerSeed{OwnerID: other})
				f.ExecWithoutForeignKeys(`INSERT INTO roles (id, server_id, name) VALUES ('r-mod', ?, 'Mod')`, s)
			},
			want: models.GuideSteps{},
		},
		{
			name: "signing in to the mobile app",
			seed: func(f *dbtest.Fixture, me, _ string) {
				f.ExecWithoutForeignKeys(`INSERT INTO push_tokens (user_id, token, platform) VALUES (?, 'tok', 'ios')`, me)
			},
			want: models.GuideSteps{App: true},
		},
		{
			name: "browser notifications are not the app",
			seed: func(f *dbtest.Fixture, me, _ string) {
				f.ExecWithoutForeignKeys(`INSERT INTO push_tokens (user_id, token, platform) VALUES (?, 'tok', 'web')`, me)
			},
			want: models.GuideSteps{},
		},
		{
			name: "everything another user did counts for them, not me",
			seed: func(f *dbtest.Fixture, _, other string) {
				f.Server(dbtest.ServerSeed{OwnerID: other})
				f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) SELECT id, ? FROM servers`, other)
				f.Message(dbtest.MessageSeed{UserID: other, Content: dbtest.Ptr("hi")})
				f.ExecWithoutForeignKeys(`UPDATE users SET last_voice_activity = CURRENT_TIMESTAMP WHERE id = ?`, other)
			},
			want: models.GuideSteps{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := dbtest.New(t)
			me, other := f.User("me"), f.User("other")
			tc.seed(f, me, other)

			got, err := NewSQLiteGuideRepo(f.DB).GetState(context.Background(), me)
			if err != nil {
				t.Fatalf("GetState: %v", err)
			}
			if got.Steps != tc.want {
				t.Fatalf("steps = %+v, want %+v", got.Steps, tc.want)
			}
		})
	}
}

func TestGuide_ADoneStepStaysDone(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	me, other := f.User("me"), f.User("other")
	repo := NewSQLiteGuideRepo(f.DB)

	s := f.Server(dbtest.ServerSeed{OwnerID: other})
	f.ExecWithoutForeignKeys(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, s, me)
	msg := f.Message(dbtest.MessageSeed{UserID: me, Content: dbtest.Ptr("hi")})
	if got, err := repo.GetState(ctx, me); err != nil || !got.Steps.Community || !got.Steps.Message {
		t.Fatalf("setup: want community and message done, got %+v err=%v", got, err)
	}

	// Leave every server and delete the only message.
	f.ExecWithoutForeignKeys(`DELETE FROM server_members WHERE user_id = ?`, me)
	f.ExecWithoutForeignKeys(`DELETE FROM messages WHERE id = ?`, msg)

	got, err := repo.GetState(ctx, me)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if !got.Steps.Community || !got.Steps.Message {
		t.Fatalf("done steps must stay done, got %+v", got.Steps)
	}
}

func TestGuide_ConcurrentReadsKeepEveryStep(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	me := f.User("me")
	repo := NewSQLiteGuideRepo(f.DB)
	f.Message(dbtest.MessageSeed{UserID: me, Content: dbtest.Ptr("hi")})
	f.ExecWithoutForeignKeys(`UPDATE users SET last_voice_activity = CURRENT_TIMESTAMP WHERE id = ?`, me)

	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() {
			_, err := repo.GetState(ctx, me)
			errs <- err
		}()
	}
	for i := 0; i < 8; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("GetState: %v", err)
		}
	}

	got, _ := repo.GetState(ctx, me)
	if !got.Steps.Message || !got.Steps.Voice {
		t.Fatalf("concurrent reads lost a step: %+v", got.Steps)
	}
}

func TestGuide_HiddenIsStoredPerAccount(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	me, other := f.User("me"), f.User("other")
	repo := NewSQLiteGuideRepo(f.DB)

	if err := repo.SetHidden(ctx, me, true); err != nil {
		t.Fatalf("SetHidden: %v", err)
	}
	mine, err := repo.GetState(ctx, me)
	if err != nil || !mine.Hidden {
		t.Fatalf("my guide should be hidden, got %+v err=%v", mine, err)
	}
	theirs, err := repo.GetState(ctx, other)
	if err != nil || theirs.Hidden {
		t.Fatalf("another account must be untouched, got %+v err=%v", theirs, err)
	}

	if err := repo.SetHidden(ctx, me, false); err != nil {
		t.Fatalf("SetHidden(false): %v", err)
	}
	if again, _ := repo.GetState(ctx, me); again.Hidden {
		t.Fatal("restoring the guide should unhide it")
	}
}

func TestGuide_TheDesktopAppMarksItself(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	me := f.User("me")
	repo := NewSQLiteGuideRepo(f.DB)

	if err := repo.MarkAppUsed(ctx, me); err != nil {
		t.Fatalf("MarkAppUsed: %v", err)
	}
	got, err := repo.GetState(ctx, me)
	if err != nil || !got.Steps.App {
		t.Fatalf("want app done, got %+v err=%v", got, err)
	}
}

func TestGuide_UnknownUserIsNotFound(t *testing.T) {
	ctx := context.Background()
	repo := NewSQLiteGuideRepo(dbtest.New(t).DB)

	if _, err := repo.GetState(ctx, "ghost"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("GetState: want ErrNotFound, got %v", err)
	}
	if err := repo.SetHidden(ctx, "ghost", true); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("SetHidden: want ErrNotFound, got %v", err)
	}
	if err := repo.MarkAppUsed(ctx, "ghost"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("MarkAppUsed: want ErrNotFound, got %v", err)
	}
}

// users.guide_done is stored: a bit moving would read old rows as different steps.
func TestGuide_StepBitsNeverMove(t *testing.T) {
	got := []int{guideCommunity, guideMessage, guideVoice, guideFriend, guideProfile, guideRoles, guideApp}
	want := []int{1, 2, 4, 8, 32, 64, 128}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("step bits = %v, want %v", got, want)
		}
	}
}

// Reading is the common case: it must not take the database's write lock when nothing changed.
func TestGuide_ReadingWritesOnlyWhenAStepAppears(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	me := f.User("me")
	repo := NewSQLiteGuideRepo(f.DB)
	f.ExecWithoutForeignKeys(`CREATE TABLE guide_writes (n INTEGER)`)
	f.ExecWithoutForeignKeys(`CREATE TRIGGER count_guide_writes AFTER UPDATE OF guide_done ON users
		BEGIN INSERT INTO guide_writes VALUES (1); END`)
	writes := func() int {
		var n int
		if err := f.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM guide_writes`).Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}

	if _, err := repo.GetState(ctx, me); err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if writes() != 0 {
		t.Fatal("a new account with nothing done must not be written")
	}

	f.Message(dbtest.MessageSeed{UserID: me, Content: dbtest.Ptr("hi")})
	got, err := repo.GetState(ctx, me)
	if err != nil || !got.Steps.Message {
		t.Fatalf("want message done, got %+v err=%v", got, err)
	}
	if writes() != 1 {
		t.Fatalf("a newly done step is written once, got %d writes", writes())
	}

	for i := 0; i < 3; i++ {
		if _, err := repo.GetState(ctx, me); err != nil {
			t.Fatalf("GetState: %v", err)
		}
	}
	if writes() != 1 {
		t.Fatalf("reading again with nothing new must not write, got %d writes", writes())
	}
}
