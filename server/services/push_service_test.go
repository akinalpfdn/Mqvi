package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
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
func (c *capturingAPNs) SendAlert(context.Context, string, string, map[string]any) error {
	return nil
}
func (c *capturingAPNs) SendBackground(context.Context, string, map[string]any) error { return nil }

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

func (disabledAPNs) Enabled() bool                                          { return false }
func (disabledAPNs) SendVoIP(context.Context, string, map[string]any) error { return nil }
func (disabledAPNs) SendAlert(context.Context, string, string, map[string]any) error {
	return nil
}
func (disabledAPNs) SendBackground(context.Context, string, map[string]any) error { return nil }

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
	// High priority is earned here: the retraction only fires when a notification is actually on
	// the tray, so it always does user-visible work. Normal priority would leave a dozing phone
	// showing a notification for a chat the user read hours ago.
	if !msgs[0].HighPriority {
		t.Error("normal priority: a dozing phone would not get this until its next maintenance window")
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

// ─── REVIEW-02: the reason= lines must be worth grepping ───

// logSink records what the service wrote, so a test can assert on the log itself — the log IS the
// feature here ("an operator can answer why this user got no notification"). Locked: push writes
// its lines from dispatch goroutines.
type logSink struct {
	mu sync.Mutex
	b  []byte
}

func (l *logSink) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.b = append(l.b, p...)
	return len(p), nil
}

func (l *logSink) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(l.b)
}

func (l *logSink) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.b = nil
}

func (l *logSink) Len() int { return len(l.String()) }

func captureLog(t *testing.T) *logSink {
	t.Helper()
	sink := &logSink{}
	prev := log.Writer()
	log.SetOutput(sink)
	t.Cleanup(func() { log.SetOutput(prev) })
	return sink
}

type apnsOnlyRepo struct{ fakeTokenRepo }

// An iOS-only user: an APNs alert token, no FCM token at all.
func newAPNsOnlyRepo() *apnsOnlyRepo {
	return &apnsOnlyRepo{fakeTokenRepo{tokens: []models.PushToken{
		{Token: "apns-1", TokenType: models.PushTokenTypeAPNs, Platform: "ios"},
	}}}
}

type countingAPNs struct {
	mu   sync.Mutex
	sent int
}

func (c *countingAPNs) Enabled() bool { return true }
func (c *countingAPNs) SendAlert(context.Context, string, string, map[string]any) error {
	c.mu.Lock()
	c.sent++
	c.mu.Unlock()
	return nil
}
func (c *countingAPNs) SendVoIP(context.Context, string, map[string]any) error { return nil }
func (c *countingAPNs) SendBackground(context.Context, string, map[string]any) error {
	return nil
}

func (c *countingAPNs) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sent
}

// The FCM path found no FCM token and said "no_tokens" — while the APNs push went out fine. The
// one log line an operator greps for was a lie for every iOS-only user.
func TestNotifyDM_DoesNotClaimNoTokensWhenAPNsDelivered(t *testing.T) {
	logs := captureLog(t)
	apnsSink := &countingAPNs{}
	s := NewPushService(&recordingFCM{sent: make(chan struct{}, 4)}, apnsSink, newAPNsOnlyRepo(),
		&fakeUsers{}, fakePresence{}, &fakeReads{}, testPushConfig(0))

	s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "")

	deadline := time.Now().Add(2 * time.Second)
	for apnsSink.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if apnsSink.count() == 0 {
		t.Fatal("the iOS user got no APNs alert at all")
	}
	if strings.Contains(logs.String(), reasonNoTokens) {
		t.Errorf("logged reason=%s for a user whose APNs push was delivered:\n%s", reasonNoTokens, logs.String())
	}
}

// With no tokens on EITHER transport, the reason is real and must be logged.
func TestNotifyDM_ReportsNoTokensWhenNeitherTransportHasAny(t *testing.T) {
	logs := captureLog(t)
	s := NewPushService(&recordingFCM{sent: make(chan struct{}, 4)}, &countingAPNs{}, &fakeTokenRepo{},
		&fakeUsers{}, fakePresence{}, &fakeReads{}, testPushConfig(0))

	s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "")

	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(logs.String(), reasonNoTokens) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(logs.String(), reasonNoTokens) {
		t.Errorf("a user with no tokens anywhere got no reason= line:\n%s", logs.String())
	}
}

// Push not configured is a boot-time fact. Logging it per message means a self-hosted instance
// writes a suppression line for EVERY DM — burying the reason= lines this feature exists for.
func TestNotifyDM_SilentWhenPushWasNeverConfigured(t *testing.T) {
	logs := captureLog(t)
	s := NewPushService(disabledFCM{}, disabledAPNs{}, &fakeTokenRepo{}, &fakeUsers{},
		fakePresence{}, &fakeReads{}, testPushConfig(0))
	logs.Reset() // the one-off "push disabled" line at construction is fine; the per-message one is not

	for i := 0; i < 5; i++ {
		s.NotifyDM("rcv", "Alice", "hi", false, "c1", "alice", "")
		s.NotifyCall("rcv", "Alice", models.P2PCallTypeVoice, "call-1", "alice")
	}

	time.Sleep(100 * time.Millisecond)
	if logs.Len() != 0 {
		t.Errorf("push is not configured on this deployment, yet every message logged:\n%s", logs.String())
	}
}

// invisibleUsers answers every lookup with a user who is invisible, which is the status that
// makes NotifyCall withhold the ring push.
type invisibleUsers struct{}

func (invisibleUsers) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id, Username: id, PrefStatus: models.UserStatusOffline}, nil
}

// The field bug this guards: with the ring push withheld for an invisible user, the cancel push
// still went out. CallManager cannot ignore a VoIP push — it must report the call to CallKit
// before ending it — so the device flashed a call screen for a call it never received.
func TestNotifyCallCancel_SilentWhenTheRingPushWasSuppressed(t *testing.T) {
	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "voip-tablet", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios"},
	}}
	sink := &capturingAPNs{sent: make(chan string, 4)}
	s := NewPushService(disabledFCM{}, sink, repo, invisibleUsers{}, nil, nil, testPushConfig(0))

	s.NotifyCall("rcv", "Alice", models.P2PCallTypeVoice, "call1", "alice")
	select {
	case tok := <-sink.sent:
		t.Fatalf("ring push went to %q although the receiver is invisible", tok)
	case <-time.After(150 * time.Millisecond):
	}

	s.NotifyCallCancel("rcv", "call1", "")
	select {
	case tok := <-sink.sent:
		t.Fatalf("cancel push went to %q for a call that never rang", tok)
	case <-time.After(150 * time.Millisecond):
	}

	// A second cancel for the same call (declined elsewhere, then the ring timeout) stays silent.
	s.NotifyCallCancel("rcv", "call1", "")
	select {
	case tok := <-sink.sent:
		t.Fatalf("repeat cancel push went to %q", tok)
	case <-time.After(150 * time.Millisecond):
	}
}

// The other half: an online receiver rings, and their cancel must still go out.
func TestNotifyCall_RingsAndCancelsForAnOnlineReceiver(t *testing.T) {
	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "voip-tablet", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios"},
	}}
	sink := &capturingAPNs{sent: make(chan string, 4)}
	s := NewPushService(disabledFCM{}, sink, repo, fakeUsers{}, nil, nil, testPushConfig(0))

	s.NotifyCall("rcv", "Alice", models.P2PCallTypeVoice, "call2", "alice")
	if got := <-sink.sent; got != "voip-tablet" {
		t.Fatalf("ring pushed %q, want voip-tablet", got)
	}

	s.NotifyCallCancel("rcv", "call2", "")
	if got := <-sink.sent; got != "voip-tablet" {
		t.Fatalf("cancel pushed %q, want voip-tablet", got)
	}
}

// heldUsers keeps every recipient lookup in flight until released: the ring is still deciding
// whether to go out when the caller hangs up.
type heldUsers struct {
	release chan struct{}
	status  models.UserStatus
}

func (u heldUsers) GetByID(ctx context.Context, id string) (*models.User, error) {
	select {
	case <-u.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return &models.User{ID: id, Username: id, PrefStatus: u.status}, nil
}

// orderedAPNs records whether each VoIP push was a ring or a cancel, in the order they left.
type orderedAPNs struct{ sent chan string }

func (o *orderedAPNs) Enabled() bool { return true }
func (o *orderedAPNs) SendVoIP(_ context.Context, _ string, payload map[string]any) error {
	if payload["cancel"] == true {
		o.sent <- "cancel"
	} else {
		o.sent <- "ring"
	}
	return nil
}
func (o *orderedAPNs) SendAlert(context.Context, string, string, map[string]any) error {
	return nil
}
func (o *orderedAPNs) SendBackground(context.Context, string, map[string]any) error { return nil }

// The ring and its cancel run on separate goroutines. A caller who hung up at once had the cancel
// checked before the ring had looked the receiver up, so a ring about to be withheld was still
// cancelled — and iOS, which must report every VoIP push to CallKit, flashed a phantom call.
func TestNotifyCallCancel_WaitsForAWithheldRingStillBeingDecided(t *testing.T) {
	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "voip-tablet", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios"},
	}}
	users := heldUsers{release: make(chan struct{}), status: models.UserStatusOffline}
	sink := &orderedAPNs{sent: make(chan string, 4)}
	s := NewPushService(disabledFCM{}, sink, repo, users, nil, nil, testPushConfig(0))

	s.NotifyCall("rcv", "Alice", models.P2PCallTypeVoice, "call3", "alice")
	s.NotifyCallCancel("rcv", "call3", "")

	select {
	case kind := <-sink.sent:
		t.Fatalf("a %s went out before the ring was decided", kind)
	case <-time.After(100 * time.Millisecond):
	}

	close(users.release)
	select {
	case kind := <-sink.sent:
		t.Fatalf("a %s went out for a call whose ring was withheld", kind)
	case <-time.After(150 * time.Millisecond):
	}
}

// The same race for a receiver who is online: the caller hangs up while the ring is still being
// decided. The cancel used to overtake the ring and leave the device ringing for a call already
// over. Now the ring sees the cancel before it sends, and nothing reaches the device at all. A
// cancel after a ring that did go out still follows it (TestNotifyCall_RingsAndCancelsForAnOnlineReceiver).
func TestNotifyCallCancel_StopsARingStillBeingDecided(t *testing.T) {
	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "voip-tablet", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios"},
	}}
	users := heldUsers{release: make(chan struct{}), status: models.UserStatusOnline}
	sink := &orderedAPNs{sent: make(chan string, 4)}
	s := NewPushService(disabledFCM{}, sink, repo, users, nil, nil, testPushConfig(0))

	s.NotifyCall("rcv", "Alice", models.P2PCallTypeVoice, "call4", "alice")
	s.NotifyCallCancel("rcv", "call4", "")

	close(users.release)
	select {
	case kind := <-sink.sent:
		t.Fatalf("a %s went out for a call hung up before it could ring", kind)
	case <-time.After(200 * time.Millisecond):
	}
}

// callAPNs records each VoIP push as "ring:<call>" or "cancel:<call>".
type callAPNs struct{ sent chan string }

func (c *callAPNs) Enabled() bool { return true }
func (c *callAPNs) SendVoIP(_ context.Context, _ string, payload map[string]any) error {
	kind := "ring"
	if payload["cancel"] == true {
		kind = "cancel"
	}
	c.sent <- fmt.Sprintf("%s:%v", kind, payload["call_id"])
	return nil
}
func (c *callAPNs) SendAlert(context.Context, string, string, map[string]any) error { return nil }
func (c *callAPNs) SendBackground(context.Context, string, map[string]any) error    { return nil }

// With the push pool full, a ring can wait for a slot longer than any fixed deadline. The cancel
// used to give up waiting after one, go first, and leave the ring to follow it: a device ringing
// for a call that was already over. A ring that was cancelled before it could go out now stays
// home, and so does its cancel.
func TestNotifyCall_ARingCancelledWhileQueuedSendsNothing(t *testing.T) {
	repo := &fakeTokenRepo{tokens: []models.PushToken{
		{Token: "voip-tablet", TokenType: models.PushTokenTypeAPNsVoIP, Platform: "ios"},
	}}
	users := heldUsers{release: make(chan struct{}), status: models.UserStatusOnline}
	sink := &callAPNs{sent: make(chan string, 16)}
	cfg := testPushConfig(0)
	s := NewPushService(disabledFCM{}, sink, repo, users, nil, nil, cfg)

	// Fill every slot with rings stuck on their lookups.
	for i := 0; i < cfg.MaxConcurrent; i++ {
		s.NotifyCall("rcv", "Alice", models.P2PCallTypeVoice, fmt.Sprintf("busy%d", i), "alice")
	}
	time.Sleep(50 * time.Millisecond) // let them take the slots

	// This ring queues behind them; the caller hangs up before it gets a slot.
	s.NotifyCall("rcv", "Alice", models.P2PCallTypeVoice, "late", "alice")
	s.NotifyCallCancel("rcv", "late", "")

	close(users.release)
	deadline := time.After(2 * time.Second)
	rings := 0
	for rings < cfg.MaxConcurrent {
		select {
		case got := <-sink.sent:
			if strings.HasSuffix(got, ":late") {
				t.Fatalf("%s went out for a call cancelled before it could ring", got)
			}
			rings++
		case <-deadline:
			t.Fatalf("only %d of the busy rings went out", rings)
		}
	}
	select {
	case got := <-sink.sent:
		if strings.HasSuffix(got, ":late") {
			t.Fatalf("%s went out for a call cancelled before it could ring", got)
		}
	case <-time.After(200 * time.Millisecond):
	}
}
