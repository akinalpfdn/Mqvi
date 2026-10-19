package repository

import (
	"context"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

func seedSession(t *testing.T, repo SessionRepository, id, userID string, expires time.Time) *models.Session {
	t.Helper()
	hash := "hash-" + id
	s := &models.Session{ID: id, UserID: userID, TokenHash: &hash, ExpiresAt: expires}
	if err := repo.Create(context.Background(), s); err != nil {
		t.Fatalf("create session: %v", err)
	}
	return s
}

func TestSessionRepo_ShouldRefuseARotationWhenTheRowChangedSinceItWasRead(t *testing.T) {
	ctx := context.Background()
	fx := dbtest.New(t)
	repo := NewSQLiteSessionRepo(fx.DB)
	stale := seedSession(t, repo, "s1", fx.User(""), time.Now().Add(time.Hour))
	now := time.Now()

	first, err := repo.Rotate(ctx, stale, models.SessionRotation{TokenHash: "h2", RotatedAt: now, ExpiresAt: now.Add(time.Hour)})
	if err != nil || !first {
		t.Fatalf("first rotation: ok=%v err=%v", first, err)
	}
	second, err := repo.Rotate(ctx, stale, models.SessionRotation{TokenHash: "h3", RotatedAt: now, ExpiresAt: now.Add(time.Hour)})

	if err != nil || second {
		t.Fatalf("rotation from a stale read: ok=%v err=%v, want refused", second, err)
	}
	got, err := repo.GetByID(ctx, "s1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.TokenHash == nil || *got.TokenHash != "h2" {
		t.Fatalf("token hash %v, want the first rotation's h2", got.TokenHash)
	}
}

func TestSessionRepo_ShouldDeleteOnlyExpiredSessions(t *testing.T) {
	ctx := context.Background()
	fx := dbtest.New(t)
	repo := NewSQLiteSessionRepo(fx.DB)
	uid := fx.User("")
	seedSession(t, repo, "old", uid, time.Now().Add(-time.Minute))
	seedSession(t, repo, "live", uid, time.Now().Add(time.Minute))

	n, err := repo.DeleteExpired(ctx, time.Now())

	if err != nil || n != 1 {
		t.Fatalf("DeleteExpired: n=%d err=%v, want 1", n, err)
	}
	if _, err := repo.GetByID(ctx, "live"); err != nil {
		t.Fatalf("live session gone: %v", err)
	}
}

func TestSessionRepo_ShouldClearPendingTokensOnlyPastTheCutoff(t *testing.T) {
	ctx := context.Background()
	fx := dbtest.New(t)
	repo := NewSQLiteSessionRepo(fx.DB)
	uid := fx.User("")
	now := time.Now()
	pending := "sealed"
	for id, rotatedAt := range map[string]time.Time{"old": now.Add(-time.Hour), "fresh": now} {
		s := seedSession(t, repo, id, uid, now.Add(time.Hour))
		if _, err := repo.Rotate(ctx, s, models.SessionRotation{
			TokenHash: "next-" + id, PendingToken: &pending, RotatedAt: rotatedAt, ExpiresAt: now.Add(time.Hour),
		}); err != nil {
			t.Fatalf("rotate %s: %v", id, err)
		}
	}

	n, err := repo.ClearPending(ctx, now.Add(-time.Minute))

	if err != nil || n != 1 {
		t.Fatalf("ClearPending: n=%d err=%v, want 1", n, err)
	}
	fresh, err := repo.GetByID(ctx, "fresh")
	if err != nil {
		t.Fatalf("get fresh: %v", err)
	}
	if fresh.PendingToken == nil {
		t.Fatal("pending token cleared inside its grace window")
	}
}

// The sweep deletes thousands of expired pre-098 rows on its first run. It must not take the push
// registrations of the devices those users are still signed in on.
func TestSessionRepo_ShouldKeepUnboundPushTokensWhenExpiredSessionsAreSwept(t *testing.T) {
	ctx := context.Background()
	fx := dbtest.New(t)
	repo := NewSQLiteSessionRepo(fx.DB)
	uid := fx.User("")
	seedSession(t, repo, "old", uid, time.Now().Add(-time.Hour))
	if _, err := fx.DB.ExecContext(ctx, `INSERT INTO push_tokens (user_id, token, platform) VALUES (?, 'legacy-fcm', 'android')`, uid); err != nil {
		t.Fatalf("seed push token: %v", err)
	}

	if _, err := repo.DeleteExpired(ctx, time.Now()); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	var left int
	if err := fx.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_tokens WHERE user_id = ?`, uid).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 1 {
		t.Fatal("the expiry sweep removed a push registration")
	}
}
