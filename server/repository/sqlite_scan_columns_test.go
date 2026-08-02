package repository

import (
	"context"
	"database/sql"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
)

// Four repositories pair a column-list const with a scan helper: users, servers, roles and
// devices. The pairing is kept in sync by hand and a mismatch is silent — two columns of the same
// type swapped still compiles, still scans, and still passed every other test in this package,
// verified by swapping display_name and avatar_url and watching nothing catch it.
//
// These are the tests that catch it. Every field gets a value distinguishable from every other of
// its type, so a reordering surfaces as a wrong value rather than as no failure at all.

func TestScanUser_EveryColumnLandsInItsOwnField(t *testing.T) {
	ctx := context.Background()
	db := newUserRepoTestDB(t)
	repo := NewSQLiteUserRepo(db)

	banned := "2031-01-02T03:04:05Z"
	deleted := "2032-02-03T04:05:06Z"
	feedback := "2033-03-04T05:06:07Z"
	reports := "2034-04-05T06:07:08Z"
	created := "2035-05-06T07:08:09Z"

	_, err := db.ExecContext(ctx, `
		INSERT INTO users (
			id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status,
			custom_status, email, language, dm_privacy, is_platform_admin, is_platform_banned,
			has_seen_download_prompt, has_seen_welcome, platform_ban_reason, platform_banned_by,
			platform_banned_at, deleted_at, deleted_by_admin, is_hard_deleted, token_version,
			feedback_last_seen_at, reports_last_seen_at, created_at
		) VALUES (
			'id-1', 'username-1', 'display-1', 'avatar-1', 'wallpaper-1', 'hash-1', 'idle', 'dnd',
			'custom-1', 'email-1', 'lang-1', 'privacy-1', 1, 1,
			1, 1, 'reason-1', 'bannedby-1',
			?, ?, 1, 1, 7,
			?, ?, ?
		)`, banned, deleted, feedback, reports, created)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	user, err := repo.GetByID(ctx, "id-1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}

	assertString(t, "ID", user.ID, "id-1")
	assertString(t, "Username", user.Username, "username-1")
	assertPtr(t, "DisplayName", user.DisplayName, "display-1")
	assertPtr(t, "AvatarURL", user.AvatarURL, "avatar-1")
	assertPtr(t, "WallpaperURL", user.WallpaperURL, "wallpaper-1")
	assertString(t, "PasswordHash", user.PasswordHash, "hash-1")
	assertString(t, "Status", string(user.Status), "idle")
	assertString(t, "PrefStatus", string(user.PrefStatus), "dnd")
	assertPtr(t, "CustomStatus", user.CustomStatus, "custom-1")
	assertPtr(t, "Email", user.Email, "email-1")
	assertString(t, "Language", user.Language, "lang-1")
	assertString(t, "DMPrivacy", user.DMPrivacy, "privacy-1")
	assertString(t, "PlatformBanReason", user.PlatformBanReason, "reason-1")
	assertString(t, "PlatformBannedBy", user.PlatformBannedBy, "bannedby-1")

	// Booleans cannot be told apart by value, so they are all set to 1: a swap between two of them
	// is invisible here and is instead covered by the distinct timestamps and strings around them.
	for name, got := range map[string]bool{
		"IsPlatformAdmin":       user.IsPlatformAdmin,
		"IsPlatformBanned":      user.IsPlatformBanned,
		"HasSeenDownloadPrompt": user.HasSeenDownloadPrompt,
		"HasSeenWelcome":        user.HasSeenWelcome,
		"DeletedByAdmin":        user.DeletedByAdmin,
		"IsHardDeleted":         user.IsHardDeleted,
	} {
		if !got {
			t.Errorf("%s = false, want true", name)
		}
	}

	if user.TokenVersion != 7 {
		t.Errorf("TokenVersion = %d, want 7", user.TokenVersion)
	}

	assertTime(t, "PlatformBannedAt", user.PlatformBannedAt, banned)
	assertTime(t, "DeletedAt", user.DeletedAt, deleted)
	assertTime(t, "FeedbackLastSeenAt", user.FeedbackLastSeenAt, feedback)
	assertTime(t, "ReportsLastSeenAt", user.ReportsLastSeenAt, reports)
	assertTime(t, "CreatedAt", &user.CreatedAt, created)
}

// Every full-user read shares one column list, so they must all produce the same row. A method
// that grew its own SELECT would drift away from the helper unnoticed.
func TestScanUser_EveryReadPathAgrees(t *testing.T) {
	ctx := context.Background()
	db := newUserRepoTestDB(t)
	repo := NewSQLiteUserRepo(db)

	_, err := db.ExecContext(ctx, `
		INSERT INTO users (id, username, display_name, avatar_url, password_hash, status, pref_status, email, language, token_version)
		VALUES ('id-2', 'username-2', 'display-2', 'avatar-2', 'hash-2', 'online', 'idle', 'email-2', 'lang-2', 3)`)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	byID, err := repo.GetByID(ctx, "id-2")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}

	reads := map[string]func() (*models.User, error){
		"GetByUsername":       func() (*models.User, error) { return repo.GetByUsername(ctx, "username-2") },
		"GetActiveByID":       func() (*models.User, error) { return repo.GetActiveByID(ctx, "id-2") },
		"GetActiveByUsername": func() (*models.User, error) { return repo.GetActiveByUsername(ctx, "username-2") },
		"GetByEmail":          func() (*models.User, error) { return repo.GetByEmail(ctx, "email-2") },
	}
	for name, read := range reads {
		got, err := read()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		// DeepEqual, not ==: User has pointer fields, and every read allocates its own.
		if !reflect.DeepEqual(got, byID) {
			t.Errorf("%s returned a different row than GetByID:\n got %s\nwant %s", name, describe(got), describe(byID))
		}
	}
}

// ListSoftDeletedExpired is the only read that goes through *sql.Rows rather than *sql.Row, so it
// exercises the other half of the scanner interface.
func TestScanUser_RowsPathMatchesTheRowPath(t *testing.T) {
	ctx := context.Background()
	db := newUserRepoTestDB(t)
	repo := NewSQLiteUserRepo(db)

	_, err := db.ExecContext(ctx, `
		INSERT INTO users (id, username, display_name, avatar_url, password_hash, status, pref_status, email, language, token_version, deleted_at, is_hard_deleted)
		VALUES ('id-3', 'username-3', 'display-3', 'avatar-3', 'hash-3', 'offline', 'online', 'email-3', 'lang-3', 5, datetime('now', '-90 days'), 0)`)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	expired, err := repo.ListSoftDeletedExpired(ctx, 30)
	if err != nil {
		t.Fatalf("ListSoftDeletedExpired: %v", err)
	}
	if len(expired) != 1 {
		t.Fatalf("got %d expired users, want 1", len(expired))
	}

	byID, err := repo.GetByID(ctx, "id-3")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if !reflect.DeepEqual(&expired[0], byID) {
		t.Errorf("the rows path returned a different row than the row path:\n got %s\nwant %s", describe(&expired[0]), describe(byID))
	}
}

func TestScanServer_EveryColumnLandsInItsOwnField(t *testing.T) {
	ctx := context.Background()
	db := newUserRepoTestDB(t)
	repo := NewSQLiteServerRepo(db)
	insertParentUser(t, db, "owner-1")
	// servers.livekit_instance_id is a foreign key; the column has to hold a real value here or the
	// test cannot tell it apart from the other nullable strings.
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances (id, url, api_key, api_secret) VALUES ('livekit-1', 'ws://lk', 'k', 's')`); err != nil {
		t.Fatalf("insert livekit instance: %v", err)
	}

	created := "2035-05-06T07:08:09Z"
	_, err := db.ExecContext(ctx, `
		INSERT INTO servers (
			id, name, icon_url, owner_id, is_public, e2ee_enabled, approval_required,
			livekit_instance_id, afk_timeout_minutes, deleted_at, deleted_by, deleted_by_admin,
			created_at, description, banner_url, category, verified, featured
		) VALUES (
			'sid-1', 'name-1', 'icon-1', 'owner-1', 1, 1, 1,
			'livekit-1', 45, NULL, NULL, 1,
			?, 'description-1', 'banner-1', 'category-1', 1, 1
		)`, created)
	if err != nil {
		t.Fatalf("insert server: %v", err)
	}

	s, err := repo.GetByID(ctx, "sid-1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}

	assertString(t, "ID", s.ID, "sid-1")
	assertString(t, "Name", s.Name, "name-1")
	assertPtr(t, "IconURL", s.IconURL, "icon-1")
	assertString(t, "OwnerID", s.OwnerID, "owner-1")
	assertPtr(t, "LiveKitInstanceID", s.LiveKitInstanceID, "livekit-1")
	assertPtr(t, "Description", s.Description, "description-1")
	assertPtr(t, "BannerURL", s.BannerURL, "banner-1")
	assertPtr(t, "Category", s.Category, "category-1")
	if s.AFKTimeoutMinutes != 45 {
		t.Errorf("AFKTimeoutMinutes = %d, want 45", s.AFKTimeoutMinutes)
	}
	assertTime(t, "CreatedAt", &s.CreatedAt, created)

	// GetActiveByID selects the same columns; a drift between the two would show here.
	active, err := repo.GetActiveByID(ctx, "sid-1")
	if err != nil {
		t.Fatalf("GetActiveByID: %v", err)
	}
	if !reflect.DeepEqual(active, s) {
		t.Errorf("GetActiveByID disagrees with GetByID:\n got %+v\nwant %+v", *active, *s)
	}
}

func TestScanRole_EveryColumnLandsInItsOwnField(t *testing.T) {
	ctx := context.Background()
	db := newUserRepoTestDB(t)
	repo := NewSQLiteRoleRepo(db)

	if _, err := db.ExecContext(ctx, `
		INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
		VALUES ('rid-1', 'server-1', 'name-1', 'color-1', 9, 12345, 1, 1, 1)`); err != nil {
		t.Fatalf("insert role: %v", err)
	}

	role, err := repo.GetByID(ctx, "rid-1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}

	assertString(t, "ID", role.ID, "rid-1")
	assertString(t, "ServerID", role.ServerID, "server-1")
	assertString(t, "Name", role.Name, "name-1")
	assertString(t, "Color", role.Color, "color-1")
	if role.Position != 9 {
		t.Errorf("Position = %d, want 9", role.Position)
	}
	if role.Permissions != 12345 {
		t.Errorf("Permissions = %d, want 12345", role.Permissions)
	}
	if !role.IsDefault || !role.IsOwner || !role.Mentionable {
		t.Errorf("flags = default:%t owner:%t mentionable:%t, want all true", role.IsDefault, role.IsOwner, role.Mentionable)
	}

	byServer, err := repo.GetAllByServer(ctx, "server-1")
	if err != nil {
		t.Fatalf("GetAllByServer: %v", err)
	}
	if len(byServer) != 1 || !reflect.DeepEqual(&byServer[0], role) {
		t.Errorf("GetAllByServer disagrees with GetByID: %+v", byServer)
	}
}

// The two joined reads qualify the columns with the "r" alias, derived from roleColumns rather
// than written out again. This pins that the derived list still matches the scan destinations.
func TestScanRole_QualifiedColumnsMatchTheBareOnes(t *testing.T) {
	ctx := context.Background()
	db := newUserRepoTestDB(t)
	repo := NewSQLiteRoleRepo(db)

	if _, err := db.ExecContext(ctx, `
		INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
		VALUES ('rid-2', 'server-2', 'name-2', 'color-2', 4, 777, 0, 0, 1)`); err != nil {
		t.Fatalf("insert role: %v", err)
	}
	insertParentUser(t, db, "user-2")
	if _, err := db.ExecContext(ctx, `
		INSERT INTO user_roles (user_id, role_id, server_id) VALUES ('user-2', 'rid-2', 'server-2')`); err != nil {
		t.Fatalf("insert user_role: %v", err)
	}

	bare, err := repo.GetByID(ctx, "rid-2")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}

	perUser, err := repo.GetByUserIDAndServer(ctx, "user-2", "server-2")
	if err != nil {
		t.Fatalf("GetByUserIDAndServer: %v", err)
	}
	if len(perUser) != 1 || !reflect.DeepEqual(&perUser[0], bare) {
		t.Errorf("the qualified read disagrees with the bare one: %+v", perUser)
	}

	grouped, err := repo.GetByServerGroupedByUser(ctx, "server-2")
	if err != nil {
		t.Fatalf("GetByServerGroupedByUser: %v", err)
	}
	// This one selects user_id before the role columns — the leading-destination path.
	if len(grouped["user-2"]) != 1 || !reflect.DeepEqual(&grouped["user-2"][0], bare) {
		t.Errorf("the grouped read disagrees with the bare one: %+v", grouped)
	}
}

func TestScanDevice_EveryColumnLandsInItsOwnField(t *testing.T) {
	ctx := context.Background()
	db := newUserRepoTestDB(t)
	repo := NewSQLiteDeviceRepo(db)
	insertParentUser(t, db, "user-1")

	if _, err := db.ExecContext(ctx, `
		INSERT INTO user_devices (
			user_id, device_id, display_name, identity_key, signing_key,
			signed_prekey, signed_prekey_id, signed_prekey_signature, registration_id
		) VALUES (
			'user-1', 'device-1', 'display-1', 'identity-1', 'signing-1',
			'prekey-1', 11, 'prekeysig-1', 22
		)`); err != nil {
		t.Fatalf("insert device: %v", err)
	}

	d, err := repo.GetByUserAndDevice(ctx, "user-1", "device-1")
	if err != nil {
		t.Fatalf("GetByUserAndDevice: %v", err)
	}

	assertString(t, "UserID", d.UserID, "user-1")
	assertString(t, "DeviceID", d.DeviceID, "device-1")
	assertPtr(t, "DisplayName", d.DisplayName, "display-1")
	assertString(t, "IdentityKey", d.IdentityKey, "identity-1")
	assertPtr(t, "SigningKey", d.SigningKey, "signing-1")
	assertString(t, "SignedPrekey", d.SignedPrekey, "prekey-1")
	assertString(t, "SignedPrekeySig", d.SignedPrekeySig, "prekeysig-1")
	if d.SignedPrekeyID != 11 {
		t.Errorf("SignedPrekeyID = %d, want 11", d.SignedPrekeyID)
	}
	if d.RegistrationID != 22 {
		t.Errorf("RegistrationID = %d, want 22", d.RegistrationID)
	}

	listed, err := repo.ListByUser(ctx, "user-1")
	if err != nil {
		t.Fatalf("ListByUser: %v", err)
	}
	if len(listed) != 1 || !reflect.DeepEqual(&listed[0], d) {
		t.Errorf("ListByUser disagrees with GetByUserAndDevice: %+v", listed)
	}
}

// The prekey bundle is a second, narrower column list over the same table, with its own pairing —
// and it reorders signed_prekey_id before signed_prekey, unlike the device list.
func TestScanPrekeyBundle_EveryColumnLandsInItsOwnField(t *testing.T) {
	ctx := context.Background()
	db := newUserRepoTestDB(t)
	repo := NewSQLiteDeviceRepo(db)
	insertParentUser(t, db, "user-3")

	if _, err := db.ExecContext(ctx, `
		INSERT INTO user_devices (
			user_id, device_id, display_name, identity_key, signing_key,
			signed_prekey, signed_prekey_id, signed_prekey_signature, registration_id
		) VALUES (
			'user-3', 'device-3', 'display-3', 'identity-3', 'signing-3',
			'prekey-3', 33, 'prekeysig-3', 44
		)`); err != nil {
		t.Fatalf("insert device: %v", err)
	}

	bundle, err := repo.GetPrekeyBundle(ctx, "user-3", "device-3")
	if err != nil {
		t.Fatalf("GetPrekeyBundle: %v", err)
	}

	assertString(t, "DeviceID", bundle.DeviceID, "device-3")
	assertString(t, "IdentityKey", bundle.IdentityKey, "identity-3")
	assertPtr(t, "SigningKey", bundle.SigningKey, "signing-3")
	assertString(t, "SignedPrekey", bundle.SignedPrekey, "prekey-3")
	assertString(t, "SignedPrekeySig", bundle.SignedPrekeySig, "prekeysig-3")
	if bundle.SignedPrekeyID != 33 {
		t.Errorf("SignedPrekeyID = %d, want 33", bundle.SignedPrekeyID)
	}
	if bundle.RegistrationID != 44 {
		t.Errorf("RegistrationID = %d, want 44", bundle.RegistrationID)
	}

	bundles, err := repo.GetPrekeyBundles(ctx, "user-3")
	if err != nil {
		t.Fatalf("GetPrekeyBundles: %v", err)
	}
	// GetPrekeyBundle consumes a one-time prekey and may attach it; the list read does not. Compare
	// only the columns the two share.
	if len(bundles) != 1 {
		t.Fatalf("got %d bundles, want 1", len(bundles))
	}
	bundles[0].OneTimePrekeyID, bundles[0].OneTimePrekey = bundle.OneTimePrekeyID, bundle.OneTimePrekey
	if !reflect.DeepEqual(&bundles[0], bundle) {
		t.Errorf("the rows path disagrees with the row path:\n got %+v\nwant %+v", bundles[0], *bundle)
	}
}

// servers.owner_id, user_devices.user_id and user_roles.user_id are all foreign keys into users.
func insertParentUser(t *testing.T, db *sql.DB, id string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'hash')`, id, id); err != nil {
		t.Fatalf("insert parent user %s: %v", id, err)
	}
}

// %+v prints pointer fields as addresses, which makes a failure unreadable.
func describe(u *models.User) string {
	deref := func(p *string) string {
		if p == nil {
			return "<nil>"
		}
		return *p
	}
	return fmt.Sprintf(
		"id=%s username=%s display=%s avatar=%s wallpaper=%s hash=%s status=%s pref=%s custom=%s email=%s lang=%s dm=%s admin=%t banned=%t tokenVersion=%d",
		u.ID, u.Username, deref(u.DisplayName), deref(u.AvatarURL), deref(u.WallpaperURL), u.PasswordHash,
		u.Status, u.PrefStatus, deref(u.CustomStatus), deref(u.Email), u.Language, u.DMPrivacy,
		u.IsPlatformAdmin, u.IsPlatformBanned, u.TokenVersion,
	)
}

func assertString(t *testing.T, field, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %q, want %q", field, got, want)
	}
}

func assertPtr(t *testing.T, field string, got *string, want string) {
	t.Helper()
	if got == nil {
		t.Errorf("%s = nil, want %q", field, want)
		return
	}
	if *got != want {
		t.Errorf("%s = %q, want %q", field, *got, want)
	}
}

func assertTime(t *testing.T, field string, got *time.Time, wantRFC3339 string) {
	t.Helper()
	if got == nil {
		t.Errorf("%s = nil, want %s", field, wantRFC3339)
		return
	}
	want, err := time.Parse(time.RFC3339, wantRFC3339)
	if err != nil {
		t.Fatalf("bad fixture %q: %v", wantRFC3339, err)
	}
	if !got.Equal(want) {
		t.Errorf("%s = %s, want %s", field, got.Format(time.RFC3339), wantRFC3339)
	}
}
