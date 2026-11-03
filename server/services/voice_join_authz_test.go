package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/testutil/dbtest"
	"github.com/akinalp/mqvi/ws"
)

// The in-memory voice state is a credential: voice chat reads it, the screen-share token reads it.
// These pin who may create it. Channels: "vc"/"vc2" voice in srv1, "other-vc" voice in srv2, "txt" text.

type authzChannels struct{}

func (authzChannels) GetByID(_ context.Context, id string) (*models.Channel, error) {
	switch id {
	case "txt":
		return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeText}, nil
	case "other-vc":
		return &models.Channel{ID: id, ServerID: "srv2", Type: models.ChannelTypeVoice}, nil
	default:
		return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
	}
}

// grants maps "user:channel" to a permission set; anything absent resolves to nothing.
type grants map[string]models.Permission

func (g grants) resolver() *testutil.MockChannelPermResolver {
	return &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, userID, channelID string) (models.Permission, error) {
			return g[userID+":"+channelID], nil
		},
	}
}

func newAuthzVoiceService(t *testing.T, g grants) (*voiceService, *[]ws.Event) {
	t.Helper()
	key := make([]byte, 32)
	apiKey, err := crypto.Encrypt("devkey", key)
	if err != nil {
		t.Fatalf("encrypt api key: %v", err)
	}
	apiSecret, err := crypto.Encrypt("devsecret", key)
	if err != nil {
		t.Fatalf("encrypt api secret: %v", err)
	}
	broadcasts := &[]ws.Event{}
	hub := &testutil.MockBroadcaster{
		BroadcastToUsersFn: func(_ []string, e ws.Event) { *broadcasts = append(*broadcasts, e) },
	}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{GetByIDFn: authzChannels{}.GetByID},
		&workingLiveKitGetter{apiKey: apiKey, apiSecret: apiSecret},
		nil,
		g.resolver(),
		hub,
		openAudience{}, openAudience{}, // audience: everyone sees everything, as before filtering
		nil, nil, key, &testutil.MockFileURLSigner{},
		nil,
	).(*voiceService)
	svc.egress.run = runVoiceEgressInline
	return svc, broadcasts
}

// memberOf answers membership from a set of "server:user"; "broken" cannot be read.
type memberOf map[string]bool

func (m memberOf) IsMember(_ context.Context, serverID, userID string) (bool, error) {
	if userID == "broken" {
		return false, errors.New("membership lookup failed")
	}
	return m[serverID+":"+userID], nil
}

// staleCache answers ConnectVoice from the cache and nothing when read fresh: a grant that was just
// taken away (override, role, kick) while the cached entry still holds it.
type staleCache struct{}

func (staleCache) ResolveChannelPermissions(context.Context, string, string) (models.Permission, error) {
	return models.PermViewChannel | models.PermConnectVoice | models.PermSpeak, nil
}

func (staleCache) ResolveChannelPermissionsFresh(context.Context, string, string) (models.Permission, error) {
	return 0, nil
}

func join(svc *voiceService, userID, channelID string) error {
	return svc.JoinChannel(userID, "name-"+userID, "", "", channelID, false, false)
}

// ─── Attack paths ───

func TestVoiceJoin_RefusedWithoutTokenOrConnectPermission(t *testing.T) {
	svc, broadcasts := newAuthzVoiceService(t, grants{})

	err := join(svc, "outsider", "vc")
	if !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused — anyone could put themselves in any voice channel", err)
	}
	if svc.GetUserVoiceState("outsider") != nil {
		t.Fatal("a refused join still created voice state")
	}
	if len(*broadcasts) != 0 {
		t.Fatalf("a refused join was announced to the server: %+v", *broadcasts)
	}
}

func TestVoiceJoin_RefusedForATextChannelEvenWithConnectPermission(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{"u1:txt": models.PermViewChannel | models.PermConnectVoice})

	if err := join(svc, "u1", "txt"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused for a text channel", err)
	}
}

func TestVoiceJoin_TokenForOneChannelDoesNotAuthorizeAnother(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{})
	svc.membership = memberOf{"srv1:u1": true}
	svc.markPendingJoin("vc", "u1", true)

	if err := join(svc, "u1", "vc2"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused — the marker is per channel", err)
	}
}

func TestVoiceJoin_ExpiredTokenMarkerDoesNotAuthorize(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{})
	svc.membership = memberOf{"srv1:u1": true}
	svc.mu.Lock()
	svc.pendingJoins["vc"] = map[string]pendingJoin{"u1": {deadline: time.Now().Add(-time.Second), viaMove: true}}
	svc.mu.Unlock()

	if err := join(svc, "u1", "vc"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused for an expired marker", err)
	}
}

// An admin disconnect removes the state; a stale re-assert from the client must not put a user
// without access straight back in.
func TestVoiceJoin_ReassertAfterDisconnectNeedsAuthorizationAgain(t *testing.T) {
	g := grants{"admin:vc": models.PermViewChannel | models.PermMoveMembers}
	svc, _ := newAuthzVoiceService(t, g)
	svc.membership = memberOf{"srv1:u1": true}
	svc.markPendingJoin("vc", "u1", true) // force-moved here: the only way in without ConnectVoice
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("authorized join: %v", err)
	}
	if err := svc.AdminDisconnectUser(context.Background(), "admin", "u1"); err != nil {
		t.Fatalf("admin disconnect: %v", err)
	}

	if err := join(svc, "u1", "vc"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused — the kicked user rejoined without a token or permission", err)
	}
}

// A token outlives what it was issued for. Taking one every 50 s keeps it ready; after a kick, a ban,
// leaving the server or losing ConnectVoice, the websocket join must ask again and be refused.
func TestVoiceJoin_TokenDoesNotOutliveTheRightItWasIssuedFor(t *testing.T) {
	g := grants{"u1:vc": models.PermViewChannel | models.PermConnectVoice | models.PermSpeak}
	svc, broadcasts := newAuthzVoiceService(t, g)
	if _, err := svc.GenerateToken(context.Background(), "u1", "u1", "", "vc"); err != nil {
		t.Fatalf("voice token: %v", err)
	}
	delete(g, "u1:vc") // kicked: no roles in srv1 any more, so no permissions

	if err := join(svc, "u1", "vc"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused — the token let a removed member back into voice", err)
	}
	if svc.GetUserVoiceState("u1") != nil {
		t.Fatal("a refused join still created voice state")
	}
	if len(*broadcasts) != 0 {
		t.Fatalf("a refused join was announced: %+v", *broadcasts)
	}
}

// The join reads the permission fresh. A cached grant can lag a just-saved override by the cache TTL.
func TestVoiceJoin_ReadsThePermissionFresh(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{})
	svc.permResolver = staleCache{}

	if err := join(svc, "u1", "vc"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused — joined on a cached grant", err)
	}
}

// A force-move token stands in for ConnectVoice, not for membership.
func TestVoiceJoin_ForceMoveTokenRefusedOnceNoLongerAMember(t *testing.T) {
	for _, tc := range []struct {
		name       string
		membership ServerMembershipChecker
		user       string
	}{
		{"kicked or banned", memberOf{}, "u1"},
		{"membership unreadable", memberOf{}, "broken"},
		{"no membership source", nil, "u1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := newAuthzVoiceService(t, grants{})
			svc.membership = tc.membership
			svc.markPendingJoin("vc", tc.user, true)

			if err := join(svc, tc.user, "vc"); !errors.Is(err, ErrVoiceJoinRefused) {
				t.Fatalf("err = %v, want ErrVoiceJoinRefused", err)
			}
		})
	}
}

func TestVoiceChat_ClosedToAUserWhoseJoinWasRefused(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{})
	_ = join(svc, "outsider", "vc")

	f := dbtest.New(t)
	chat := NewVoiceMessageService(repository.NewSQLiteVoiceMessageRepo(f.DB), svc, &testutil.MockBroadcaster{}, &testutil.MockFileURLSigner{}, &testutil.MockFileDeleter{})

	if _, err := chat.List(context.Background(), "outsider", "vc", 50); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden — voice chat history readable after a refused join", err)
	}
}

func TestScreenShareToken_RefusedWithoutSpeak(t *testing.T) {
	// In voice legitimately (token issued), but the channel denies Speak.
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermViewChannel | models.PermConnectVoice})
	if _, err := svc.GenerateToken(context.Background(), "u1", "u1", "", "vc"); err != nil {
		t.Fatalf("voice token: %v", err)
	}
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}

	if _, err := svc.GenerateScreenShareToken(context.Background(), "u1", "u1", "", "vc"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden — the screen identity let a user without Speak publish", err)
	}
}

func TestScreenShareToken_CannotPublishAMicrophone(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermViewChannel | models.PermConnectVoice | models.PermSpeak})
	if _, err := svc.GenerateToken(context.Background(), "u1", "u1", "", "vc"); err != nil {
		t.Fatalf("voice token: %v", err)
	}
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}

	resp, err := svc.GenerateScreenShareToken(context.Background(), "u1", "u1", "", "vc")
	if err != nil {
		t.Fatalf("screen token: %v", err)
	}
	v, err := auth.ParseAPIToken(resp.Token)
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}
	_, claims, err := v.Verify("devsecret")
	if err != nil {
		t.Fatalf("verify token: %v", err)
	}
	video := claims.Video
	if video.GetCanPublishSource(livekit.TrackSource_MICROPHONE) || video.GetCanPublishSource(livekit.TrackSource_CAMERA) {
		t.Fatalf("screen identity may publish %v — it must be screen share only", video.CanPublishSources)
	}
	if !video.GetCanPublishSource(livekit.TrackSource_SCREEN_SHARE) || !video.GetCanPublishSource(livekit.TrackSource_SCREEN_SHARE_AUDIO) {
		t.Fatalf("screen identity lost its own sources: %v", video.CanPublishSources)
	}
}

func TestMoveUser_AnotherUserCannotBeMovedToAnotherServer(t *testing.T) {
	g := grants{
		"mod:vc":       models.PermMoveMembers | models.PermViewChannel | models.PermConnectVoice,
		"mod:other-vc": models.PermMoveMembers | models.PermViewChannel | models.PermConnectVoice,
	}
	g["victim:vc"] = models.PermViewChannel | models.PermConnectVoice
	svc, _ := newAuthzVoiceService(t, g)
	if err := join(svc, "victim", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}

	err := svc.MoveUser(context.Background(), "mod", "victim", "other-vc")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden for a cross-server move of another user", err)
	}
	if st := svc.GetUserVoiceState("victim"); st == nil || st.ChannelID != "vc" {
		t.Fatalf("victim was moved anyway: %+v", st)
	}
}

// ─── Legitimate paths that must keep working ───

func TestVoiceJoin_AllowedWithConnectPermission(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermViewChannel | models.PermConnectVoice})

	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("a member with ConnectVoice was refused: %v", err)
	}
	if st := svc.GetUserVoiceState("u1"); st == nil || st.ChannelID != "vc" {
		t.Fatalf("state = %+v, want in vc", st)
	}
}

// The normal client sequence: token first, then the websocket join.
func TestVoiceJoin_AllowedAfterAVoiceToken(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermViewChannel | models.PermConnectVoice | models.PermSpeak})
	if _, err := svc.GenerateToken(context.Background(), "u1", "u1", "", "vc"); err != nil {
		t.Fatalf("voice token: %v", err)
	}
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("join after token: %v", err)
	}
}

// A force-moved user holds no ConnectVoice in the target. MoveUser moves the state; the client then
// takes a token (consuming the one-time grant) and sends voice_join for the target.
func TestVoiceJoin_ForceMovedUserWithoutConnectPermissionStays(t *testing.T) {
	g := grants{
		"mod:vc":   models.PermMoveMembers | models.PermViewChannel | models.PermConnectVoice,
		"mod:vc2":  models.PermMoveMembers | models.PermViewChannel | models.PermConnectVoice,
		"user:vc":  models.PermViewChannel | models.PermConnectVoice | models.PermSpeak,
		"user:vc2": 0, // staff-only room
	}
	svc, _ := newAuthzVoiceService(t, g)
	if err := join(svc, "user", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}
	if err := svc.MoveUser(context.Background(), "mod", "user", "vc2"); err != nil {
		t.Fatalf("move: %v", err)
	}
	if _, err := svc.GenerateToken(context.Background(), "user", "user", "", "vc2"); err != nil {
		t.Fatalf("token after force-move: %v", err)
	}
	if err := join(svc, "user", "vc2"); err != nil {
		t.Fatalf("the force-moved user's own join was refused: %v", err)
	}
	if st := svc.GetUserVoiceState("user"); st == nil || st.ChannelID != "vc2" {
		t.Fatalf("state = %+v, want in vc2", st)
	}
}

// The force-moved user's state is gone before their join lands (orphan or reconcile reap). The token
// minted on the grant still lets them in while they are a member.
func TestVoiceJoin_ForceMovedUserWhoseStateWasLostRejoins(t *testing.T) {
	g := grants{
		"mod:vc":   models.PermMoveMembers | models.PermViewChannel | models.PermConnectVoice,
		"mod:vc2":  models.PermMoveMembers | models.PermViewChannel | models.PermConnectVoice,
		"user:vc":  models.PermViewChannel | models.PermConnectVoice | models.PermSpeak,
		"user:vc2": 0,
	}
	svc, _ := newAuthzVoiceService(t, g)
	svc.membership = memberOf{"srv1:user": true}
	if err := join(svc, "user", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}
	if err := svc.MoveUser(context.Background(), "mod", "user", "vc2"); err != nil {
		t.Fatalf("move: %v", err)
	}
	if _, err := svc.GenerateToken(context.Background(), "user", "user", "", "vc2"); err != nil {
		t.Fatalf("token after force-move: %v", err)
	}
	svc.DisconnectUser("user") // the state is reaped before the websocket join arrives

	if err := join(svc, "user", "vc2"); err != nil {
		t.Fatalf("the force-moved user could not rejoin on their token: %v", err)
	}
}

// WS reconnect while LiveKit is still up: the client re-asserts with no new token. A user already in
// the channel passes whatever their permissions say now.
func TestVoiceJoin_SameChannelReassertNeedsNoPermission(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{})
	svc.membership = memberOf{"srv1:u1": true}
	svc.markPendingJoin("vc", "u1", true)
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("first join: %v", err)
	}

	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("same-channel re-assert refused: %v", err)
	}
}

func TestMoveUser_SelfMoveAcrossServersStillAllowed(t *testing.T) {
	g := grants{"u1:vc": models.PermViewChannel | models.PermConnectVoice, "u1:other-vc": models.PermViewChannel | models.PermConnectVoice}
	svc, _ := newAuthzVoiceService(t, g)
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}
	if err := svc.MoveUser(context.Background(), "u1", "u1", "other-vc"); err != nil {
		t.Fatalf("self-move to another server's channel refused: %v", err)
	}
}

// ─── Hidden channels: ConnectVoice without ViewChannel ───

// An override hides the channel (ViewChannel denied) but the base role still grants ConnectVoice.
// The sidebar never shows it; knowing its id must not get anyone in, and a channel they cannot see
// answers exactly like one that does not exist.
const hiddenGrant = models.PermConnectVoice | models.PermSpeak

func TestHiddenVoiceChannel_TokenAnswersLikeAMissingChannel(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": hiddenGrant})

	_, err := svc.GenerateToken(context.Background(), "u1", "u1", "", "vc")

	if !errors.Is(err, pkg.ErrNotFound) || err.Error() != pkg.ErrNotFound.Error() {
		t.Fatalf("err = %v, want exactly %v — a hidden channel must not be told apart from a missing one", err, pkg.ErrNotFound)
	}
}

func TestHiddenVoiceChannel_WebsocketJoinRefused(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": hiddenGrant})

	if err := join(svc, "u1", "vc"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused", err)
	}
}

func TestHiddenVoiceChannel_SelfMoveAnswersLikeAMissingChannel(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermViewChannel | models.PermConnectVoice, "u1:vc2": hiddenGrant})
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}

	err := svc.MoveUser(context.Background(), "u1", "u1", "vc2")

	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if st := svc.GetUserVoiceState("u1"); st == nil || st.ChannelID != "vc" {
		t.Fatalf("u1 moved into a hidden channel: %+v", st)
	}
}

// A moderator holds MoveMembers/MuteMembers server-wide but cannot see the staff room. Acting on
// someone in it must fail exactly as if that someone were not in voice — or the error tells anyone
// with an id whether a user is in a call, on any server.
func TestHiddenVoiceChannel_ModeratorActionsSayNothingAboutIt(t *testing.T) {
	modOnly := models.PermMoveMembers | models.PermMuteMembers | models.PermDeafenMembers | models.PermConnectVoice
	g := grants{
		"mod:vc":    models.PermViewChannel | modOnly,
		"mod:vc2":   modOnly, // hidden from the mod
		"staff:vc2": models.PermViewChannel | models.PermConnectVoice,
	}
	ctx := context.Background()
	yes := true
	attempts := map[string]func(svc *voiceService, target string) error{
		"disconnect": func(svc *voiceService, target string) error { return svc.AdminDisconnectUser(ctx, "mod", target) },
		"mute": func(svc *voiceService, target string) error {
			return svc.AdminUpdateState(ctx, "mod", target, &yes, nil)
		},
		"deafen": func(svc *voiceService, target string) error {
			return svc.AdminUpdateState(ctx, "mod", target, nil, &yes)
		},
		"move out": func(svc *voiceService, target string) error { return svc.MoveUser(ctx, "mod", target, "vc") },
	}
	for name, act := range attempts {
		t.Run(name, func(t *testing.T) {
			svc, _ := newAuthzVoiceService(t, g)
			if err := join(svc, "staff", "vc2"); err != nil {
				t.Fatalf("join: %v", err)
			}

			inHidden := act(svc, "staff")
			absent := act(svc, "nobody")

			if inHidden == nil {
				t.Fatal("the moderator acted on a participant of a channel they cannot see")
			}
			if absent == nil || inHidden.Error() != absent.Error() {
				t.Fatalf("hidden participant: %v; absent user: %v — the two must be indistinguishable", inHidden, absent)
			}
			if st := svc.GetUserVoiceState("staff"); st == nil || st.ChannelID != "vc2" || st.IsServerMuted || st.IsServerDeafened {
				t.Fatalf("staff was changed: %+v", st)
			}
		})
	}
}

// Moving someone into a channel the moderator cannot see answers like a missing channel.
func TestHiddenVoiceChannel_ModeratorCannotMoveIntoIt(t *testing.T) {
	g := grants{
		"mod:vc":    models.PermViewChannel | models.PermMoveMembers | models.PermConnectVoice,
		"mod:vc2":   models.PermMoveMembers | models.PermConnectVoice,
		"member:vc": models.PermViewChannel | models.PermConnectVoice,
	}
	svc, _ := newAuthzVoiceService(t, g)
	if err := join(svc, "member", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}

	err := svc.MoveUser(context.Background(), "mod", "member", "vc2")

	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// A moderator who sees the channel but lacks the permission is still told so: they can see the call.
func TestHiddenVoiceChannel_AVisibleCallStillGetsForbidden(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{
		"mod:vc":    models.PermViewChannel,
		"member:vc": models.PermViewChannel | models.PermConnectVoice,
	})
	if err := join(svc, "member", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}

	if err := svc.AdminDisconnectUser(context.Background(), "mod", "member"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

// A user moved by someone else carries that move; moving themselves or joining anew drops it.
func TestMovedIn_SetOnlyBySomeoneElsesMove(t *testing.T) {
	g := grants{
		"mod:vc":   models.PermViewChannel | models.PermMoveMembers | models.PermConnectVoice,
		"mod:vc2":  models.PermViewChannel | models.PermMoveMembers | models.PermConnectVoice,
		"user:vc":  models.PermViewChannel | models.PermConnectVoice,
		"user:vc2": models.PermViewChannel | models.PermConnectVoice,
	}
	svc, _ := newAuthzVoiceService(t, g)
	if err := join(svc, "user", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}
	if err := svc.MoveUser(context.Background(), "mod", "user", "vc2"); err != nil {
		t.Fatalf("move: %v", err)
	}
	if st := svc.GetUserVoiceState("user"); st == nil || !st.MovedIn {
		t.Fatalf("after a moderator's move: %+v, want MovedIn", st)
	}
	if err := svc.MoveUser(context.Background(), "user", "user", "vc"); err != nil {
		t.Fatalf("self-move: %v", err)
	}
	if st := svc.GetUserVoiceState("user"); st == nil || st.MovedIn {
		t.Fatalf("after a self-move: %+v, want not MovedIn", st)
	}
	if err := svc.MoveUser(context.Background(), "mod", "user", "vc2"); err != nil {
		t.Fatalf("move: %v", err)
	}
	if err := join(svc, "user", "vc"); err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	if st := svc.GetUserVoiceState("user"); st == nil || st.MovedIn {
		t.Fatalf("after joining anew: %+v, want not MovedIn", st)
	}
}
