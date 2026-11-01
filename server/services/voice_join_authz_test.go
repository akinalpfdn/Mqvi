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
	).(*voiceService)
	svc.egress.run = runVoiceEgressInline
	return svc, broadcasts
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
	svc, _ := newAuthzVoiceService(t, grants{"u1:txt": models.PermConnectVoice})

	if err := join(svc, "u1", "txt"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused for a text channel", err)
	}
}

func TestVoiceJoin_TokenForOneChannelDoesNotAuthorizeAnother(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{})
	svc.markPendingJoin("vc", "u1")

	if err := join(svc, "u1", "vc2"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused — the marker is per channel", err)
	}
}

func TestVoiceJoin_ExpiredTokenMarkerDoesNotAuthorize(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{})
	svc.mu.Lock()
	svc.pendingJoins["vc"] = map[string]time.Time{"u1": time.Now().Add(-time.Second)}
	svc.mu.Unlock()

	if err := join(svc, "u1", "vc"); !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want ErrVoiceJoinRefused for an expired marker", err)
	}
}

// An admin disconnect removes the state; a stale re-assert from the client must not put a user
// without access straight back in.
func TestVoiceJoin_ReassertAfterDisconnectNeedsAuthorizationAgain(t *testing.T) {
	g := grants{"admin:vc": models.PermMoveMembers}
	svc, _ := newAuthzVoiceService(t, g)
	svc.markPendingJoin("vc", "u1")
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
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermConnectVoice})
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
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermConnectVoice | models.PermSpeak})
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
		"mod:vc":       models.PermMoveMembers | models.PermConnectVoice,
		"mod:other-vc": models.PermMoveMembers | models.PermConnectVoice,
	}
	svc, _ := newAuthzVoiceService(t, g)
	svc.markPendingJoin("vc", "victim")
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
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermConnectVoice})

	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("a member with ConnectVoice was refused: %v", err)
	}
	if st := svc.GetUserVoiceState("u1"); st == nil || st.ChannelID != "vc" {
		t.Fatalf("state = %+v, want in vc", st)
	}
}

// The normal client sequence: token first, then the websocket join.
func TestVoiceJoin_AllowedAfterAVoiceToken(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{"u1:vc": models.PermConnectVoice | models.PermSpeak})
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
		"mod:vc":   models.PermMoveMembers | models.PermConnectVoice,
		"mod:vc2":  models.PermMoveMembers | models.PermConnectVoice,
		"user:vc":  models.PermConnectVoice | models.PermSpeak,
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

// WS reconnect while LiveKit is still up: the client re-asserts with no new token. A user already in
// the channel passes whatever their permissions say now.
func TestVoiceJoin_SameChannelReassertNeedsNoPermission(t *testing.T) {
	svc, _ := newAuthzVoiceService(t, grants{})
	svc.markPendingJoin("vc", "u1")
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("first join: %v", err)
	}

	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("same-channel re-assert refused: %v", err)
	}
}

func TestMoveUser_SelfMoveAcrossServersStillAllowed(t *testing.T) {
	g := grants{"u1:vc": models.PermConnectVoice, "u1:other-vc": models.PermConnectVoice}
	svc, _ := newAuthzVoiceService(t, g)
	if err := join(svc, "u1", "vc"); err != nil {
		t.Fatalf("join: %v", err)
	}
	if err := svc.MoveUser(context.Background(), "u1", "u1", "other-vc"); err != nil {
		t.Fatalf("self-move to another server's channel refused: %v", err)
	}
}
