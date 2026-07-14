package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/akinalp/mqvi/config"
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
func (disabledFCM) SendData(context.Context, []string, push.DataMessage) ([]string, error) {
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

	s := NewPushService(disabledFCM{}, sink, repo, nil, nil, nil, testPushConfig(0))
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

	s := NewPushService(disabledFCM{}, sink, repo, nil, nil, nil, testPushConfig(0))
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
func (c *capturingFCM) SendData(context.Context, []string, push.DataMessage) ([]string, error) {
	return nil, nil
}

type disabledAPNs struct{}

func (disabledAPNs) Enabled() bool                                           { return false }
func (disabledAPNs) SendVoIP(context.Context, string, map[string]any) error  { return nil }
func (disabledAPNs) SendAlert(context.Context, string, map[string]any) error { return nil }

func dmPushService(t *testing.T, online, alreadyRead bool, delay time.Duration) (PushNotifier, *capturingFCM, *fakeReads) {
	t.Helper()
	fcm := &capturingFCM{sent: make(chan string, 4)}
	reads := &fakeReads{read: alreadyRead, asked: make(chan struct{}, 4)}
	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "android-1", TokenType: models.PushTokenTypeFCM, Platform: "android"},
	}}
	s := NewPushService(fcm, disabledAPNs{}, repo, &fakeUsers{},
		fakePresence{online: online}, reads, testPushConfig(delay))
	return s, fcm, reads
}

func testPushConfig(delay time.Duration) config.PushConfig {
	return config.PushConfig{
		DMDelay:                 delay,
		ReadRetraction:          true,
		MaxConcurrent:           4,
		CircuitFailureThreshold: 5,
		CircuitWindow:           30 * time.Second,
		CircuitOpen:             30 * time.Second,
	}
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

// ─── FIX-06: operability ───

// recordingFCM captures data messages and can be told to fail.
type recordingFCM struct {
	mu       sync.Mutex
	notifs   int
	data     []push.DataMessage
	failWith error
	sent     chan struct{}
}

func (r *recordingFCM) Enabled() bool { return true }

func (r *recordingFCM) Send(context.Context, []string, push.Notification) ([]string, error) {
	r.mu.Lock()
	r.notifs++
	r.mu.Unlock()
	if r.failWith != nil {
		return nil, r.failWith
	}
	r.signal()
	return nil, nil
}

func (r *recordingFCM) SendData(_ context.Context, _ []string, m push.DataMessage) ([]string, error) {
	r.mu.Lock()
	r.data = append(r.data, m)
	r.mu.Unlock()
	if r.failWith != nil {
		return nil, r.failWith
	}
	r.signal()
	return nil, nil
}

func (r *recordingFCM) signal() {
	select {
	case r.sent <- struct{}{}:
	default:
	}
}

func (r *recordingFCM) dataMessages() []push.DataMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]push.DataMessage(nil), r.data...)
}

func (r *recordingFCM) notifCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.notifs
}

// countingTokenRepo records how often the database was asked for tokens. That call is a
// connection checkout on a four-connection pool, so "did we even ask" is the load question.
type countingTokenRepo struct {
	fakeTokenRepo
	lookups atomic.Int64
}

func (c *countingTokenRepo) ListByUser(ctx context.Context, id string) ([]models.PushToken, error) {
	c.lookups.Add(1)
	return c.fakeTokenRepo.ListByUser(ctx, id)
}

func opsPushService(cfg config.PushConfig) (PushNotifier, *recordingFCM, *countingTokenRepo) {
	fcm := &recordingFCM{sent: make(chan struct{}, 16)}
	repo := &countingTokenRepo{fakeTokenRepo: fakeTokenRepo{tokens: []models.PushToken{
		{Token: "android-1", TokenType: models.PushTokenTypeFCM, Platform: "android"},
	}}}
	s := NewPushService(fcm, disabledAPNs{}, repo, &fakeUsers{},
		fakePresence{online: false}, &fakeReads{asked: make(chan struct{}, 4)}, cfg)
	return s, fcm, repo
}

// A retraction for a conversation that was never notified is pure noise — and it is most of the
// traffic, because most reads happen on a conversation the phone was never told about. That noise
// is what overflows FCM's 100-message queue for an offline device and takes the queued CALL
// notifications down with it.
func TestNotifyDMRead_SilentWhenNothingWasEverDelivered(t *testing.T) {
	s, fcm, _ := opsPushService(testPushConfig(0))

	s.NotifyDMRead("rcv", "c1")

	time.Sleep(100 * time.Millisecond)
	if got := len(fcm.dataMessages()); got != 0 {
		t.Errorf("sent %d retraction pushes for a conversation with nothing on the tray", got)
	}
}

func TestNotifyDMRead_RetractsOnceWhenSomethingWasDelivered(t *testing.T) {
	s, fcm, _ := opsPushService(testPushConfig(0))

	s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "m1")
	<-fcm.sent // the notification landed on their tray

	s.NotifyDMRead("rcv", "c1")
	<-fcm.sent

	msgs := fcm.dataMessages()
	if len(msgs) != 1 {
		t.Fatalf("sent %d retractions, want exactly 1", len(msgs))
	}
	if msgs[0].CollapseKey != "dm_read:c1" {
		t.Errorf("collapse key %q, want dm_read:c1 — without a per-conversation key, a read of one "+
			"chat replaces the retraction queued for another", msgs[0].CollapseKey)
	}
	if msgs[0].HighPriority {
		t.Error("high priority on a push that shows the user nothing — this is what gets a sender downranked, and the downranking lands on calls")
	}

	// The tray is clear now. Reading again must not push again.
	s.NotifyDMRead("rcv", "c1")
	time.Sleep(100 * time.Millisecond)
	if got := len(fcm.dataMessages()); got != 1 {
		t.Errorf("sent %d retractions after the tray was already cleared, want 1", got)
	}
}

func TestNotifyDMRead_SilentWhenTheKillSwitchIsOff(t *testing.T) {
	cfg := testPushConfig(0)
	cfg.ReadRetraction = false
	s, fcm, _ := opsPushService(cfg)

	s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "m1")
	<-fcm.sent
	s.NotifyDMRead("rcv", "c1")

	time.Sleep(100 * time.Millisecond)
	if got := len(fcm.dataMessages()); got != 0 {
		t.Errorf("MQVI_PUSH_DM_READ_RETRACTION=false still sent %d retractions", got)
	}
}

// The point of the breaker is not to fail faster — it is to stop paying for the failure. A send
// that is going to time out still checks out a database connection on the way there, and the pool
// has four of them. That is how an FCM outage becomes a message-send outage.
func TestNotifyDM_BreakerStopsTouchingTheDatabaseOnceFCMIsDown(t *testing.T) {
	cfg := testPushConfig(0)
	cfg.CircuitFailureThreshold = 3
	cfg.CircuitOpen = time.Minute
	s, fcm, repo := opsPushService(cfg)
	fcm.failWith = errors.New("fcm is down")

	for i := 0; i < 3; i++ {
		s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "")
	}
	// Wait for the breaker to have seen all three failures.
	deadline := time.Now().Add(2 * time.Second)
	for fcm.notifCount() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if fcm.notifCount() < 3 {
		t.Fatalf("only %d sends were attempted, want 3", fcm.notifCount())
	}
	lookupsWhileFailing := repo.lookups.Load()

	for i := 0; i < 5; i++ {
		s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "")
	}
	time.Sleep(200 * time.Millisecond)

	if got := repo.lookups.Load(); got != lookupsWhileFailing {
		t.Errorf("%d further token lookups after the breaker opened — the outage is still costing database connections",
			got-lookupsWhileFailing)
	}
	if fcm.notifCount() != 3 {
		t.Errorf("%d sends attempted, want 3 — the breaker did not stop calling a dependency that is down", fcm.notifCount())
	}
}

// ─── REVIEW-01: the outstanding map must drain, and must not lose a record it never sent ───

// The freeze: markOutstanding refused to add at the cap and takeOutstanding returned true WITHOUT
// deleting, so the map stuck at exactly the cap forever. Every read from then on fired an
// unconditional retraction — the FCM queue overflow the map exists to prevent, made permanent.
func TestOutstanding_DrainsWhenFull(t *testing.T) {
	s := NewPushService(&recordingFCM{sent: make(chan struct{}, 1)}, disabledAPNs{},
		&fakeTokenRepo{}, &fakeUsers{}, fakePresence{}, &fakeReads{}, testPushConfig(0)).(*pushService)

	for i := 0; i < maxTrackedNotifications; i++ {
		s.markOutstanding("u", fmt.Sprintf("c%d", i))
	}
	if got := len(s.outstanding); got != maxTrackedNotifications {
		t.Fatalf("map holds %d, want %d", got, maxTrackedNotifications)
	}

	// One more delivery: it cannot be recorded, so the map is now lying by omission.
	s.markOutstanding("u", "overflow")

	// Reading a tracked conversation must still shrink the map.
	if !s.takeOutstanding("u", "c0") {
		t.Error("a conversation we recorded reported nothing outstanding")
	}
	if got := len(s.outstanding); got != maxTrackedNotifications-1 {
		t.Fatalf("map is stuck at %d — reads no longer drain it, so it never recovers", got)
	}

	// While records are being dropped we must retract unconditionally, or the notification for
	// "overflow" is stranded on the lock screen with nothing left to pull it back.
	if !s.takeOutstanding("u", "overflow") {
		t.Error("refused to retract a conversation whose delivery went unrecorded")
	}
}

// A shed retraction must not consume the record. The notification is still on the tray; the
// server forgetting about it means no later read will ever retry.
func TestNotifyDMRead_ShedRetractionKeepsTheRecord(t *testing.T) {
	s := NewPushService(&recordingFCM{sent: make(chan struct{}, 1)}, disabledAPNs{},
		&fakeTokenRepo{}, &fakeUsers{}, fakePresence{}, &fakeReads{}, testPushConfig(0)).(*pushService)

	s.markOutstanding("u", "c1")
	s.queued.Store(maxQueuedDMPushes) // the dispatch queue is full: this retraction will be shed

	s.NotifyDMRead("u", "c1")

	time.Sleep(100 * time.Millisecond)
	if !s.hasOutstanding("u", "c1") {
		t.Error("the shed retraction consumed the record — the notification is stranded and nothing will retry")
	}
}

// And when the send itself fails, the record goes back for the same reason.
func TestNotifyDMRead_FailedSendPutsTheRecordBack(t *testing.T) {
	fcm := &recordingFCM{sent: make(chan struct{}, 1), failWith: errors.New("fcm down")}
	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "android-1", TokenType: models.PushTokenTypeFCM, Platform: "android"},
	}}
	s := NewPushService(fcm, disabledAPNs{}, repo, &fakeUsers{},
		fakePresence{}, &fakeReads{}, testPushConfig(0)).(*pushService)

	s.markOutstanding("u", "c1")
	s.NotifyDMRead("u", "c1")

	deadline := time.Now().Add(2 * time.Second)
	for len(fcm.dataMessages()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(fcm.dataMessages()) == 0 {
		t.Fatal("no retraction was attempted")
	}
	if !s.hasOutstanding("u", "c1") {
		t.Error("a failed retraction dropped the record — the notification stays on the tray forever")
	}
}
