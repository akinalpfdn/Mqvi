package services

import (
	"context"
	"testing"

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
