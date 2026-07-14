package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/apns"
	"github.com/akinalp/mqvi/pkg/push"
)

// fakeTokenRepo serves a fixed token list and records nothing else.
type fakeTokenRepo struct{ tokens []models.PushToken }

func (f *fakeTokenRepo) Upsert(context.Context, *models.PushToken) error { return nil }
func (f *fakeTokenRepo) ListByUser(context.Context, string) ([]models.PushToken, error) {
	return f.tokens, nil
}
func (f *fakeTokenRepo) Delete(context.Context, string, string) error { return nil }
func (f *fakeTokenRepo) DeleteTokens(context.Context, []string) error { return nil }

// capturingAPNs records which VoIP tokens were actually pushed to.
type capturingAPNs struct{ sent chan string }

func (c *capturingAPNs) Enabled() bool { return true }
func (c *capturingAPNs) SendVoIP(_ context.Context, token string, _ map[string]any) error {
	c.sent <- token
	return nil
}
func (c *capturingAPNs) SendAlert(context.Context, string, map[string]any) error { return nil }

type disabledFCM struct{}

func (disabledFCM) Enabled() bool { return false }
func (disabledFCM) Send(context.Context, []string, push.Notification) ([]string, error) {
	return nil, nil
}
func (disabledFCM) SendData(context.Context, []string, map[string]string) ([]string, error) {
	return nil, nil
}

// The whole point of the device chain: the token belonging to the device that answered must not
// receive the "stop ringing" push. On iOS that push arrives for a call the user is IN, and the
// only way to ignore it is to complete the PushKit handler without reporting a call to CallKit —
// which Apple punishes by killing the app and revoking its VoIP delivery.
func TestNotifyCallCancel_SkipsTheDeviceThatActed(t *testing.T) {
	phone := "phone-device"
	tablet := "tablet-device"

	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "voip-phone", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios", DeviceID: &phone},
		{Token: "voip-tablet", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios", DeviceID: &tablet},
	}}
	sink := &capturingAPNs{sent: make(chan string, 4)}

	s := &pushService{fcm: disabledFCM{}, apns: sink, tokenRepo: repo, users: nil}
	s.NotifyCallCancel("rcv", "call1", phone)

	got := <-sink.sent
	if got != "voip-tablet" {
		t.Fatalf("pushed %q, want voip-tablet", got)
	}
	select {
	case extra := <-sink.sent:
		t.Errorf("pushed %q as well — the device that answered was told to stop ringing", extra)
	default:
	}
}

// A token with no device id predates the chain. It must still be reachable, or old installs
// would stop being told to stop ringing.
func TestNotifyCallCancel_StillReachesTokensWithNoDeviceID(t *testing.T) {
	phone := "phone-device"

	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "voip-old", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios", DeviceID: nil},
		{Token: "voip-phone", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios", DeviceID: &phone},
	}}
	sink := &capturingAPNs{sent: make(chan string, 4)}

	s := &pushService{fcm: disabledFCM{}, apns: sink, tokenRepo: repo, users: nil}
	s.NotifyCallCancel("rcv", "call1", phone)

	if got := <-sink.sent; got != "voip-old" {
		t.Fatalf("pushed %q, want voip-old", got)
	}
}

var _ apns.Sender = (*capturingAPNs)(nil)

// ─── FIX-04: the read is PROVED, never claimed ───

type fakePresence struct{ online bool }

func (f fakePresence) IsOnline(string) bool { return f.online }

type fakeReads struct {
	read bool
	err  error
	// asked records that the watermark was actually consulted.
	asked chan struct{}
}

func (f *fakeReads) HasRead(context.Context, string, string, string) (bool, error) {
	select {
	case f.asked <- struct{}{}:
	default:
	}
	return f.read, f.err
}

type capturingFCM struct{ sent chan string }

func (c *capturingFCM) Enabled() bool { return true }
func (c *capturingFCM) Send(_ context.Context, tokens []string, _ push.Notification) ([]string, error) {
	for _, t := range tokens {
		c.sent <- t
	}
	return nil, nil
}
func (c *capturingFCM) SendData(context.Context, []string, map[string]string) ([]string, error) {
	return nil, nil
}

type disabledAPNs struct{}

func (disabledAPNs) Enabled() bool                                           { return false }
func (disabledAPNs) SendVoIP(context.Context, string, map[string]any) error  { return nil }
func (disabledAPNs) SendAlert(context.Context, string, map[string]any) error { return nil }

func dmPushService(t *testing.T, online, alreadyRead bool, delay time.Duration) (*pushService, *capturingFCM, *fakeReads) {
	t.Helper()
	fcm := &capturingFCM{sent: make(chan string, 4)}
	reads := &fakeReads{read: alreadyRead, asked: make(chan struct{}, 4)}
	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "android-1", TokenType: models.PushTokenTypeFCM, Platform: "android"},
	}}
	s := &pushService{
		fcm: fcm, apns: disabledAPNs{}, tokenRepo: repo, users: &fakeUsers{},
		presence: fakePresence{online: online}, reads: reads, dmDelay: delay,
	}
	return s, fcm, reads
}

type fakeUsers struct{}

func (fakeUsers) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id, Username: id, PrefStatus: models.UserStatusOnline}, nil
}

// The whole point of deleting the focus protocol: the user reading the conversation is PROVED
// against the watermark, not claimed by a client. If they read it, no push.
func TestNotifyDM_SkippedWhenTheWatermarkProvesTheyReadIt(t *testing.T) {
	s, fcm, reads := dmPushService(t, true, true, 20*time.Millisecond)

	s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "m1")

	select {
	case <-reads.asked:
	case <-time.After(2 * time.Second):
		t.Fatal("the watermark was never consulted — the push did not wait to find out")
	}
	select {
	case tok := <-fcm.sent:
		t.Errorf("pushed to %q for a message the user has demonstrably read", tok)
	case <-time.After(300 * time.Millisecond):
	}
}

// And if they did NOT read it, the push goes out. A claim that turns out to be wrong costs
// latency, never silence.
func TestNotifyDM_SentWhenTheyDidNotReadIt(t *testing.T) {
	s, fcm, _ := dmPushService(t, true, false, 20*time.Millisecond)

	s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "m1")

	select {
	case tok := <-fcm.sent:
		if tok != "android-1" {
			t.Errorf("pushed to %q, want android-1", tok)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the message was never read and no push went out — a notification was lost")
	}
}

// No socket anywhere: nobody could be reading it, so waiting buys nothing. Push at once.
// This is the common mobile case — app closed, phone in a pocket.
func TestNotifyDM_ImmediateWhenTheUserHasNoLiveSocket(t *testing.T) {
	s, fcm, reads := dmPushService(t, false, true, time.Hour) // read=true would suppress IF asked

	s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "m1")

	select {
	case <-fcm.sent:
	case <-time.After(2 * time.Second):
		t.Fatal("an offline user waited for a read that could never happen")
	}
	select {
	case <-reads.asked:
		t.Error("the watermark was consulted for a user with no socket — pointless work")
	default:
	}
}

// A failing read check must never swallow the notification.
func TestNotifyDM_SendsAnywayWhenTheReadCheckFails(t *testing.T) {
	s, fcm, reads := dmPushService(t, true, true, 20*time.Millisecond)
	reads.err = errors.New("db is down")

	s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "m1")

	select {
	case <-fcm.sent:
	case <-time.After(2 * time.Second):
		t.Fatal("a failed read check silently swallowed the notification")
	}
}
