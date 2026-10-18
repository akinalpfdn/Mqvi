package services

import (
	"context"
	"errors"
	"strings"
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

type recordingRevoker struct {
	revoked []string
	except  []string
}

func (r *recordingRevoker) RevokeAuthSessions(_ string, ids []string) {
	r.revoked = append(r.revoked, ids...)
}
func (r *recordingRevoker) RevokeAuthSessionsExcept(_ string, keep ...string) { r.except = keep }

// fixedLocator answers every address with the same place.
type fixedLocator struct{ city, country string }

func (f fixedLocator) Lookup(string) (string, string) { return f.city, f.country }

type devicesHarness struct {
	t       *testing.T
	fx      *dbtest.Fixture
	auth    AuthService
	devices SessionService
	revoker *recordingRevoker
}

func newDevicesHarness(t *testing.T) *devicesHarness {
	t.Helper()
	fx := dbtest.New(t)
	sessions := repository.NewSQLiteSessionRepo(fx.DB)
	revoker := &recordingRevoker{}
	auth := NewAuthService(
		repository.NewSQLiteUserRepo(fx.DB), sessions,
		&testutil.MockResetRepo{}, &testutil.MockEventPublisher{}, &testutil.MockEmailSender{},
		password.NoopChecker{}, fixedLocator{"Istanbul", "TR"}, testJWTSecret, testEncryptionKey, 15, 90, 24,
	)
	return &devicesHarness{t: t, fx: fx, auth: auth, devices: NewSessionService(sessions, revoker), revoker: revoker}
}

// signIn starts a session for userID from a device, returning its session id.
func (h *devicesHarness) signIn(userID string, client models.ClientInfo) string {
	h.t.Helper()
	user, err := repository.NewSQLiteUserRepo(h.fx.DB).GetByID(context.Background(), userID)
	if err != nil {
		h.t.Fatalf("load user: %v", err)
	}
	tokens, err := h.auth.(*authService).generateTokens(context.Background(), user, client)
	if err != nil {
		h.t.Fatalf("generateTokens: %v", err)
	}
	sid, _, _ := strings.Cut(tokens.RefreshToken, ".")
	return sid
}

func TestSessions_ShouldListTheUsersDevicesWithWhereTheyAreAndWhichOneIsThisOne(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	laptop := h.signIn(uid, models.ClientInfo{Platform: "windows", DeviceLabel: "Desktop app", IP: "81.214.1.1"})
	phone := h.signIn(uid, models.ClientInfo{Platform: "android", DeviceLabel: "Mobile app", IP: "81.214.1.2"})
	h.signIn(h.fx.User(""), models.ClientInfo{Platform: "ios"}) // someone else's

	views, err := h.devices.List(context.Background(), uid, laptop)

	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(views) != 2 {
		t.Fatalf("got %d sessions, want the user's 2", len(views))
	}
	byID := map[string]models.SessionView{}
	for _, v := range views {
		byID[v.ID] = v
	}
	if !byID[laptop].IsCurrent || byID[phone].IsCurrent {
		t.Fatal("current device not marked, or the wrong one marked")
	}
	p := byID[phone]
	if *p.Platform != "android" || *p.DeviceLabel != "Mobile app" || *p.IP != "81.214.1.2" || *p.City != "Istanbul" || *p.Country != "TR" {
		t.Fatalf("phone row: %+v", p)
	}
}

func TestSessions_ShouldDropAnUnknownPlatformAndTrimTheLabel(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	sid := h.signIn(uid, models.ClientInfo{Platform: "toaster", DeviceLabel: " \x00" + strings.Repeat("x", 200)})

	views, err := h.devices.List(context.Background(), uid, sid)

	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if views[0].Platform != nil {
		t.Fatalf("unknown platform stored: %q", *views[0].Platform)
	}
	if got := *views[0].DeviceLabel; len([]rune(got)) != 64 || strings.ContainsRune(got, 0) {
		t.Fatalf("label not normalised: %q", got)
	}
}

func TestSessions_ShouldKeepKnownDeviceDetailsWhenARefreshReportsNone(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	user, err := repository.NewSQLiteUserRepo(h.fx.DB).GetByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	tokens, err := h.auth.(*authService).generateTokens(context.Background(), user, models.ClientInfo{Platform: "macos", DeviceLabel: "Desktop app"})
	if err != nil {
		t.Fatalf("sign in: %v", err)
	}

	if _, err := h.auth.RefreshToken(context.Background(), tokens.RefreshToken, models.ClientInfo{}); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	sid, _, _ := strings.Cut(tokens.RefreshToken, ".")
	views, err := h.devices.List(context.Background(), uid, sid)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if views[0].Platform == nil || *views[0].Platform != "macos" {
		t.Fatal("an older client's refresh blanked the stored platform")
	}
}

func TestSessions_ShouldSignOutAnotherDeviceAndCutItsConnections(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	current := h.signIn(uid, models.ClientInfo{})
	other := h.signIn(uid, models.ClientInfo{})

	if err := h.devices.Revoke(context.Background(), uid, current, other); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	views, _ := h.devices.List(context.Background(), uid, current)
	if len(views) != 1 || views[0].ID != current {
		t.Fatalf("after revoke: %+v", views)
	}
	if len(h.revoker.revoked) != 1 || h.revoker.revoked[0] != other {
		t.Fatalf("connections revoked for %v, want %s", h.revoker.revoked, other)
	}
}

func TestSessions_ShouldNotRevealOrRevokeAnotherUsersSession(t *testing.T) {
	h := newDevicesHarness(t)
	me := h.fx.User("")
	mine := h.signIn(me, models.ClientInfo{})
	theirs := h.signIn(h.fx.User(""), models.ClientInfo{})

	err := h.devices.Revoke(context.Background(), me, mine, theirs)

	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
	var left int
	if err := h.fx.DB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id = ?`, theirs).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 1 {
		t.Fatal("another user's session was deleted")
	}
}

func TestSessions_ShouldRefuseToRevokeTheCurrentDevice(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	current := h.signIn(uid, models.ClientInfo{})

	err := h.devices.Revoke(context.Background(), uid, current, current)

	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("got %v, want ErrBadRequest", err)
	}
}

func TestSessions_ShouldSignOutEveryOtherDeviceButKeepThisOne(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	current := h.signIn(uid, models.ClientInfo{})
	h.signIn(uid, models.ClientInfo{})
	h.signIn(uid, models.ClientInfo{})

	n, err := h.devices.RevokeOthers(context.Background(), uid, current)

	if err != nil || n != 2 {
		t.Fatalf("RevokeOthers: n=%d err=%v, want 2", n, err)
	}
	views, _ := h.devices.List(context.Background(), uid, current)
	if len(views) != 1 || !views[0].IsCurrent {
		t.Fatalf("after revoke-others: %+v", views)
	}
	if len(h.revoker.except) != 1 || h.revoker.except[0] != current {
		t.Fatalf("connections kept for %v, want only %q", h.revoker.except, current)
	}
}

func TestSessions_ShouldRefuseRevokeOthersWhenThisDeviceIsUnnamed(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	h.signIn(uid, models.ClientInfo{})

	_, err := h.devices.RevokeOthers(context.Background(), uid, "")

	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("got %v, want ErrBadRequest", err)
	}
	if views, _ := h.devices.List(context.Background(), uid, ""); len(views) != 1 {
		t.Fatal("sessions were deleted without knowing which one is this device")
	}
}

func TestValidateSession_ShouldRejectATokenWhoseSessionWasRevoked(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	current := h.signIn(uid, models.ClientInfo{})
	other := h.signIn(uid, models.ClientInfo{})
	if err := h.devices.Revoke(context.Background(), uid, current, other); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	err := h.auth.ValidateSession(context.Background(), &models.TokenClaims{UserID: uid, SessionID: other})

	if !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("got %v, want ErrUnauthorized", err)
	}
	if err := h.auth.ValidateSession(context.Background(), &models.TokenClaims{UserID: uid, SessionID: current}); err != nil {
		t.Fatalf("live session rejected: %v", err)
	}
}

func TestValidateSession_ShouldRejectASessionIDThatBelongsToSomeoneElse(t *testing.T) {
	h := newDevicesHarness(t)
	theirs := h.signIn(h.fx.User(""), models.ClientInfo{})

	err := h.auth.ValidateSession(context.Background(), &models.TokenClaims{UserID: h.fx.User(""), SessionID: theirs})

	if !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("got %v, want ErrUnauthorized", err)
	}
}

func TestValidateSession_ShouldLetATokenWithoutASessionThrough(t *testing.T) {
	h := newDevicesHarness(t)

	if err := h.auth.ValidateSession(context.Background(), &models.TokenClaims{UserID: "u"}); err != nil {
		t.Fatalf("pre-sid token rejected: %v", err)
	}
}

func TestSignOut_ShouldRemoveTheDevicesPushTokenWithItsSession(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	current := h.signIn(uid, models.ClientInfo{})
	phone := h.signIn(uid, models.ClientInfo{})
	push := NewPushTokenService(repository.NewSQLitePushTokenRepo(h.fx.DB))
	if _, err := push.RegisterToken(context.Background(), uid, phone, &models.RegisterPushTokenRequest{Token: "fcm-1", Platform: "android"}); err != nil {
		t.Fatalf("register push: %v", err)
	}

	if err := h.devices.Revoke(context.Background(), uid, current, phone); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	tokens, err := push.ListUserTokens(context.Background(), uid)
	if err != nil {
		t.Fatalf("list push: %v", err)
	}
	if len(tokens) != 0 {
		t.Fatal("a signed-out phone keeps its push token")
	}
}

func TestChangePassword_ShouldCloseTheOtherDevicesConnections(t *testing.T) {
	fx := dbtest.New(t)
	users := repository.NewSQLiteUserRepo(fx.DB)
	if _, err := fx.DB.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', ?)`,
		preHashPassword(t, testRegisterPassword)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var keptFor string
	var keep []string
	hub := &testutil.MockEventPublisher{
		RevokeAuthSessionsExceptFn: func(userID string, ids ...string) { keptFor, keep = userID, ids },
	}
	auth := NewAuthService(users, repository.NewSQLiteSessionRepo(fx.DB),
		&testutil.MockResetRepo{}, hub, &testutil.MockEmailSender{},
		password.NoopChecker{}, geoip.Noop{}, testJWTSecret, testEncryptionKey, 15, 90, 24,
	)

	tokens, err := auth.ChangePassword(context.Background(), "u1", "s-this-device", testRegisterPassword, "another horse battery staple", models.ClientInfo{})

	if err != nil {
		t.Fatalf("change password: %v", err)
	}
	sid, _, _ := strings.Cut(tokens.RefreshToken, ".")
	// The new session and the old one this device's open sockets still carry.
	if keptFor != "u1" || len(keep) != 2 || keep[0] != sid || keep[1] != "s-this-device" {
		t.Fatalf("revoked connections for %q except %v, want u1 except [%s s-this-device]", keptFor, keep, sid)
	}
}

// Tokens registered before push tokens carried a session cannot cascade; a sign-out must still
// take them, or a signed-out phone keeps showing message previews.
func TestSignOut_ShouldAlsoDropPushTokensRegisteredWithoutASession(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	current := h.signIn(uid, models.ClientInfo{})
	phone := h.signIn(uid, models.ClientInfo{})
	if _, err := h.fx.DB.Exec(
		`INSERT INTO push_tokens (user_id, token, platform) VALUES (?, 'legacy-fcm', 'android')`, uid,
	); err != nil {
		t.Fatalf("seed legacy push token: %v", err)
	}

	if err := h.devices.Revoke(context.Background(), uid, current, phone); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	var left int
	if err := h.fx.DB.QueryRow(`SELECT COUNT(*) FROM push_tokens WHERE user_id = ?`, uid).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatal("an unbound push token survived the sign-out")
	}
}

func TestChangePassword_ShouldDropPushTokensRegisteredWithoutASession(t *testing.T) {
	fx := dbtest.New(t)
	if _, err := fx.DB.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', ?)`,
		preHashPassword(t, testRegisterPassword)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	auth := NewAuthService(repository.NewSQLiteUserRepo(fx.DB), repository.NewSQLiteSessionRepo(fx.DB),
		&testutil.MockResetRepo{}, &testutil.MockEventPublisher{}, &testutil.MockEmailSender{},
		password.NoopChecker{}, geoip.Noop{}, testJWTSecret, testEncryptionKey, 15, 90, 24,
	)
	user, err := repository.NewSQLiteUserRepo(fx.DB).GetByID(context.Background(), "u1")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	if _, err := auth.(*authService).generateTokens(context.Background(), user, models.ClientInfo{}); err != nil {
		t.Fatalf("sign in: %v", err)
	}
	if _, err := fx.DB.Exec(`INSERT INTO push_tokens (user_id, token, platform) VALUES ('u1', 'legacy-fcm', 'android')`); err != nil {
		t.Fatalf("seed legacy push token: %v", err)
	}

	if _, err := auth.ChangePassword(context.Background(), "u1", "", testRegisterPassword, "another horse battery staple", models.ClientInfo{}); err != nil {
		t.Fatalf("change password: %v", err)
	}

	var left int
	if err := fx.DB.QueryRow(`SELECT COUNT(*) FROM push_tokens`).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatal("an unbound push token survived a password change that signed every device out")
	}
}

func TestSessions_ShouldStoreOnlyARealAddress(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	forged := h.signIn(uid, models.ClientInfo{IP: "<script>" + strings.Repeat("x", 5000)})
	mapped := h.signIn(uid, models.ClientInfo{IP: " ::ffff:81.214.1.1 "})

	views, err := h.devices.List(context.Background(), uid, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	byID := map[string]models.SessionView{}
	for _, v := range views {
		byID[v.ID] = v
	}
	if byID[forged].IP != nil {
		t.Fatalf("a non-address was stored: %q", *byID[forged].IP)
	}
	if byID[mapped].IP == nil || *byID[mapped].IP != "81.214.1.1" {
		t.Fatalf("mapped address not normalised: %v", byID[mapped].IP)
	}
}

func TestChangePassword_ShouldNotSpareUnnamedConnectionsWhenThisDeviceIsUnnamed(t *testing.T) {
	fx := dbtest.New(t)
	if _, err := fx.DB.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', ?)`,
		preHashPassword(t, testRegisterPassword)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var keep []string
	hub := &testutil.MockEventPublisher{
		RevokeAuthSessionsExceptFn: func(_ string, ids ...string) { keep = ids },
	}
	auth := NewAuthService(repository.NewSQLiteUserRepo(fx.DB), repository.NewSQLiteSessionRepo(fx.DB),
		&testutil.MockResetRepo{}, hub, &testutil.MockEmailSender{},
		password.NoopChecker{}, geoip.Noop{}, testJWTSecret, testEncryptionKey, 15, 90, 24,
	)

	if _, err := auth.ChangePassword(context.Background(), "u1", "", testRegisterPassword, "another horse battery staple", models.ClientInfo{}); err != nil {
		t.Fatalf("change password: %v", err)
	}

	if len(keep) != 1 || keep[0] == "" {
		t.Fatalf("kept %v, want only the new session", keep)
	}
}

// Sessions from before the sweep existed were never deleted; an expired one is not a device.
func TestSessions_ShouldNotListExpiredSessions(t *testing.T) {
	h := newDevicesHarness(t)
	uid := h.fx.User("")
	current := h.signIn(uid, models.ClientInfo{})
	stale := h.signIn(uid, models.ClientInfo{})
	if _, err := h.fx.DB.Exec(`UPDATE sessions SET expires_at = ? WHERE id = ?`, time.Now().UTC().Add(-time.Hour), stale); err != nil {
		t.Fatalf("expire: %v", err)
	}

	views, err := h.devices.List(context.Background(), uid, current)

	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(views) != 1 || views[0].ID != current {
		t.Fatalf("listed %d sessions, want only the live one", len(views))
	}
}
