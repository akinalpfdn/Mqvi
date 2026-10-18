package services

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/geoip"
	"github.com/akinalp/mqvi/pkg/password"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

// Rotation is decided by what the sessions row holds, so these run against the real schema and
// repository rather than a mock that would only echo the test's own assumptions back.
type sessionHarness struct {
	t   *testing.T
	db  *sql.DB
	svc AuthService
	uid string
}

func newSessionHarness(t *testing.T) *sessionHarness {
	t.Helper()
	fx := dbtest.New(t)
	uid := fx.User("")
	svc := NewAuthService(
		repository.NewSQLiteUserRepo(fx.DB), repository.NewSQLiteSessionRepo(fx.DB),
		&testutil.MockResetRepo{}, &testutil.MockEventPublisher{}, &testutil.MockEmailSender{},
		password.NoopChecker{}, geoip.Noop{}, testJWTSecret, testEncryptionKey, 15, 90, 24,
	)
	return &sessionHarness{t: t, db: fx.DB, svc: svc, uid: uid}
}

// signIn starts a device session the way login does.
func (h *sessionHarness) signIn() *AuthTokens {
	h.t.Helper()
	user, err := repository.NewSQLiteUserRepo(h.db).GetByID(context.Background(), h.uid)
	if err != nil {
		h.t.Fatalf("load user: %v", err)
	}
	tokens, err := h.svc.(*authService).generateTokens(context.Background(), user, models.ClientInfo{})
	if err != nil {
		h.t.Fatalf("generateTokens: %v", err)
	}
	return tokens
}

func (h *sessionHarness) refresh(token string) (*AuthTokens, error) {
	return h.svc.RefreshToken(context.Background(), token, models.ClientInfo{})
}

func (h *sessionHarness) mustRefresh(token string) *AuthTokens {
	h.t.Helper()
	tokens, err := h.refresh(token)
	if err != nil {
		h.t.Fatalf("refresh: %v", err)
	}
	return tokens
}

// endGraceWindow moves the last rotation of every session far enough back that the grace window
// is over.
func (h *sessionHarness) endGraceWindow() {
	h.t.Helper()
	past := time.Now().UTC().Add(-2 * refreshGraceWindow)
	if _, err := h.db.Exec(`UPDATE sessions SET rotated_at = ?`, past); err != nil {
		h.t.Fatalf("age rotation: %v", err)
	}
}

func (h *sessionHarness) sessionCount() int {
	h.t.Helper()
	var n int
	if err := h.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = ?`, h.uid).Scan(&n); err != nil {
		h.t.Fatalf("count sessions: %v", err)
	}
	return n
}

func TestRefresh_ShouldRotateWithinTheSameSessionWhenTheCurrentTokenIsPresented(t *testing.T) {
	h := newSessionHarness(t)
	first := h.signIn()

	second := h.mustRefresh(first.RefreshToken)

	if second.RefreshToken == first.RefreshToken {
		t.Fatal("refresh returned the same token outside a repeat")
	}
	if h.sessionCount() != 1 {
		t.Fatalf("got %d sessions, want 1 (rotation must not create a device)", h.sessionCount())
	}
	h.mustRefresh(second.RefreshToken)
}

func TestRefresh_ShouldAnswerWithTheSameSuccessorWhenTheTokenIsRepeatedInsideTheGraceWindow(t *testing.T) {
	h := newSessionHarness(t)
	first := h.signIn()

	tabA := h.mustRefresh(first.RefreshToken)
	tabB := h.mustRefresh(first.RefreshToken)

	if tabA.RefreshToken != tabB.RefreshToken {
		t.Fatal("two tabs sharing one storage got different successors; whichever is stored last would be dead")
	}
	h.mustRefresh(tabA.RefreshToken)
}

func TestRefresh_ShouldStaySignedInWhenTheRotationResponseWasLost(t *testing.T) {
	h := newSessionHarness(t)
	first := h.signIn()
	lost := h.mustRefresh(first.RefreshToken) // the client never receives this
	h.endGraceWindow()

	retry := h.mustRefresh(first.RefreshToken)

	if retry.RefreshToken == lost.RefreshToken {
		t.Fatal("a token re-issued after the grace window must be new, not the unsent one")
	}
	h.mustRefresh(retry.RefreshToken)
}

func TestRefresh_ShouldRevokeTheSessionWhenATokenOlderThanThePreviousIsReplayed(t *testing.T) {
	h := newSessionHarness(t)
	stolen := h.signIn()
	second := h.mustRefresh(stolen.RefreshToken)
	third := h.mustRefresh(second.RefreshToken)

	_, err := h.refresh(stolen.RefreshToken)

	if !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("replay of a two-generations-old token: got %v want ErrUnauthorized", err)
	}
	if h.sessionCount() != 0 {
		t.Fatal("session survived a replayed token")
	}
	if _, err := h.refresh(third.RefreshToken); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("current token after revocation: got %v want ErrUnauthorized", err)
	}
}

// The case where a stale token is used first: the owner comes back with the token the thief
// replaced, and the thief must not keep the session.
func TestRefresh_ShouldLockOutTheHolderOfAReplacedTokenWhenTheOwnerReturns(t *testing.T) {
	h := newSessionHarness(t)
	owner := h.signIn()
	ownerNext := h.mustRefresh(owner.RefreshToken)
	h.endGraceWindow()
	thief := h.mustRefresh(owner.RefreshToken) // previous token, past grace: replaces ownerNext

	_, err := h.refresh(ownerNext.RefreshToken)

	if !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("owner's replaced token: got %v want ErrUnauthorized", err)
	}
	if _, err := h.refresh(thief.RefreshToken); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("thief after detection: got %v want ErrUnauthorized", err)
	}
}

func TestRefresh_ShouldGiveEveryConcurrentRequestTheSameWorkingTokenWhenTheyRace(t *testing.T) {
	h := newSessionHarness(t)
	first := h.signIn()

	const n = 8
	results := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tokens, err := h.refresh(first.RefreshToken)
			errs[i] = err
			if err == nil {
				results[i] = tokens.RefreshToken
			}
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		if results[i] != results[0] {
			t.Fatalf("request %d got a different successor", i)
		}
	}
	h.mustRefresh(results[0])
}

func TestRefresh_ShouldUpgradeAPlaintextSessionWhenItIsFirstRefreshed(t *testing.T) {
	h := newSessionHarness(t)
	const legacy = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44"
	if _, err := h.db.Exec(
		`INSERT INTO sessions (id, user_id, legacy_token, expires_at) VALUES ('legacy1', ?, ?, ?)`,
		h.uid, legacy, time.Now().UTC().Add(time.Hour),
	); err != nil {
		t.Fatalf("seed legacy session: %v", err)
	}

	upgraded := h.mustRefresh(legacy)

	if !strings.HasPrefix(upgraded.RefreshToken, "legacy1.") {
		t.Fatalf("upgraded token %q does not name its session", upgraded.RefreshToken)
	}
	var plaintext int
	if err := h.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE legacy_token IS NOT NULL`).Scan(&plaintext); err != nil {
		t.Fatalf("count plaintext: %v", err)
	}
	if plaintext != 0 {
		t.Fatal("plaintext token still stored after rotation")
	}
	if repeat := h.mustRefresh(legacy); repeat.RefreshToken != upgraded.RefreshToken {
		t.Fatal("legacy token repeated inside the grace window got a different successor")
	}
	h.mustRefresh(upgraded.RefreshToken)
}

func TestRefresh_ShouldRejectAndDeleteTheSessionWhenItHasExpired(t *testing.T) {
	h := newSessionHarness(t)
	tokens := h.signIn()
	if _, err := h.db.Exec(`UPDATE sessions SET expires_at = ?`, time.Now().UTC().Add(-time.Minute)); err != nil {
		t.Fatalf("expire: %v", err)
	}

	_, err := h.refresh(tokens.RefreshToken)

	if !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("got %v want ErrUnauthorized", err)
	}
	if h.sessionCount() != 0 {
		t.Fatal("expired session not deleted")
	}
}

func TestRefresh_ShouldExtendTheSessionWhenItIsUsed(t *testing.T) {
	h := newSessionHarness(t)
	tokens := h.signIn()
	nearEnd := time.Now().UTC().Add(time.Hour)
	if _, err := h.db.Exec(`UPDATE sessions SET expires_at = ?`, nearEnd); err != nil {
		t.Fatalf("shorten: %v", err)
	}

	h.mustRefresh(tokens.RefreshToken)

	var expiresAt time.Time
	if err := h.db.QueryRow(`SELECT expires_at FROM sessions`).Scan(&expiresAt); err != nil {
		t.Fatalf("read expiry: %v", err)
	}
	if expiresAt.Before(time.Now().Add(89 * 24 * time.Hour)) {
		t.Fatalf("expiry %v was not pushed out to the full lifetime", expiresAt)
	}
}

func TestIssuedTokens_ShouldCarryTheSessionID(t *testing.T) {
	h := newSessionHarness(t)
	tokens := h.signIn()

	access, err := h.svc.ValidateAccessToken(tokens.AccessToken)
	if err != nil {
		t.Fatalf("validate access: %v", err)
	}
	file, err := h.svc.ValidateFileToken(tokens.FileToken)
	if err != nil {
		t.Fatalf("validate file: %v", err)
	}

	sid, _, _ := strings.Cut(tokens.RefreshToken, ".")
	if access.SessionID != sid || file.SessionID != sid {
		t.Fatalf("sid claims access=%q file=%q, want %q", access.SessionID, file.SessionID, sid)
	}
}

func TestIssuedTokens_ShouldGiveTheFileTokenItsOwnLifetime(t *testing.T) {
	h := newSessionHarness(t)
	tokens := h.signIn()

	file, err := h.svc.ValidateFileToken(tokens.FileToken)
	if err != nil {
		t.Fatalf("validate file: %v", err)
	}

	if ttl := time.Until(file.ExpiresAt.Time); ttl > 25*time.Hour || ttl < 23*time.Hour {
		t.Fatalf("file token lives %v, want the configured 24h", ttl)
	}
}

func TestLogout_ShouldEndTheSessionWhenItsTokenIsPresented(t *testing.T) {
	h := newSessionHarness(t)
	tokens := h.signIn()

	if err := h.svc.Logout(context.Background(), tokens.RefreshToken); err != nil {
		t.Fatalf("logout: %v", err)
	}

	if h.sessionCount() != 0 {
		t.Fatal("session survived logout")
	}
}

func TestLogout_ShouldIgnoreATokenWhoseSecretDoesNotMatchItsSession(t *testing.T) {
	h := newSessionHarness(t)
	tokens := h.signIn()
	sid, _, _ := strings.Cut(tokens.RefreshToken, ".")

	if err := h.svc.Logout(context.Background(), sid+".forged"); err != nil {
		t.Fatalf("logout: %v", err)
	}

	if h.sessionCount() != 1 {
		t.Fatal("a forged secret signed the device out")
	}
}

func TestLogout_ShouldSucceedWhenTheTokenIsUnknown(t *testing.T) {
	h := newSessionHarness(t)

	if err := h.svc.Logout(context.Background(), "nope.nope"); err != nil {
		t.Fatalf("logout: %v", err)
	}
}
