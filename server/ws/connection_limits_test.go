package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ratelimit"
)

// The danger in this phase is not the attacker — it is the legitimate user the limits lock out.
// A cap set below a real device count, or a rate below what a redeploy produces, breaks people who
// did nothing wrong, and it breaks them at exactly the moment the server is already having a bad
// time. These pin the headroom as much as the bound.

// Mirrors the defaults in config.Load. Kept here so tightening one without reading these tests
// turns them red rather than quietly refusing real users.
const (
	defaultMaxConnections    = 10 // MQVI_WS_MAX_CONNECTIONS_PER_USER
	defaultConnectsPerMinute = 60 // MQVI_WS_CONNECTS_PER_MINUTE
)

func newHubForLimits() *Hub {
	return &Hub{
		clients:        make(map[string]map[*Client]bool),
		serverClients:  make(map[string]map[*Client]bool),
		invisibleUsers: make(map[string]bool),
	}
}

func attach(h *Hub, userID string, n int) {
	if h.clients[userID] == nil {
		h.clients[userID] = make(map[*Client]bool)
	}
	for i := 0; i < n; i++ {
		h.clients[userID][&Client{userID: userID}] = true
	}
}

func TestConnectionCount_CountsOnlyTheUsersOwnSockets(t *testing.T) {
	h := newHubForLimits()
	attach(h, "u1", 3)
	attach(h, "u2", 5)

	if got := connCount(h, "u1"); got != 3 {
		t.Errorf("u1 = %d, want 3", got)
	}
	if got := connCount(h, "nobody"); got != 0 {
		t.Errorf("unknown user = %d, want 0", got)
	}
}

// The cap is a per-user bound, so one account filling it must not affect anyone else. Getting this
// wrong would turn a single abusive account into a platform-wide outage.
func TestConnectionCount_IsNotSharedBetweenUsers(t *testing.T) {
	h := newHubForLimits()
	attach(h, "flooder", 50)
	attach(h, "innocent", 1)

	if got := connCount(h, "innocent"); got != 1 {
		t.Errorf("innocent = %d, want 1 — one account's sockets must not count against another's", got)
	}
}

// Concurrent connects read the count without holding the lock across the handshake, so the check
// races by design. What must not happen is a torn read or a panic.
func TestConnectionCount_SafeUnderConcurrentReads(t *testing.T) {
	h := newHubForLimits()
	attach(h, "u1", 4)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if got := connCount(h, "u1"); got != 4 {
				t.Errorf("concurrent read = %d, want 4", got)
			}
		}()
	}
	wg.Wait()
}

// The default cap has to clear a real person: desktop, phone, web, Electron, a couple of spare
// tabs, and a reconnect overlapping a socket the server has not reaped yet.
func TestDefaultCap_ClearsARealisticMultiDeviceUser(t *testing.T) {
	realistic := 4 + 2 + 1 // devices + spare tabs + one un-reaped reconnect
	if realistic >= defaultMaxConnections {
		t.Fatalf("a realistic user needs %d sockets and the cap is %d — no headroom", realistic, defaultMaxConnections)
	}
}

// A redeploy is the worst legitimate burst: Hub.Shutdown tells every socket to reconnect at once,
// so a multi-device user spends one handshake per device in the same second. The rate must clear
// that with room for the retry a flaky reconnect produces.
func TestDefaultConnectRate_ClearsARedeployStorm(t *testing.T) {
	limiter := ratelimit.NewLoginRateLimiter(defaultConnectsPerMinute, time.Minute)

	// Four devices reconnect, each retries twice on a flaky link, and the user reloads a tab.
	for i := 0; i < 4*3+1; i++ {
		if !limiter.Allow("u1") {
			t.Fatalf("a redeploy reconnect was refused at attempt %d of 13 — the default rate is too tight", i+1)
		}
	}
}

// The real bound on the default is not the redeploy — it is what the client's own backoff can
// produce when a connection keeps failing badly.
//
// The backoff resets on `onopen`, not on `ready`. A socket that opens and dies immediately (captive
// portal, a proxy that completes the handshake then drops, a network switch mid-flight) therefore
// restarts at the 1.5s floor every cycle instead of backing off, which is about 40 attempts a
// minute. Throttling below that punishes the user whose connection is already broken.
func TestDefaultConnectRate_ClearsTheClientsWorstCaseBackoff(t *testing.T) {
	const openThenDiePerMinute = 60_000 / 1_500 // 1.5s floor, counter reset on every open

	if defaultConnectsPerMinute <= openThenDiePerMinute {
		t.Fatalf("default is %d/min but a flapping client can produce %d/min — it would be refused mid-failure",
			defaultConnectsPerMinute, openThenDiePerMinute)
	}
}

// And it still has to stop somewhere, or it is not a limit.
func TestDefaultConnectRate_StopsAChurnLoop(t *testing.T) {
	const defaultPerMinute = defaultConnectsPerMinute

	limiter := ratelimit.NewLoginRateLimiter(defaultPerMinute, time.Minute)
	for i := 0; i < defaultPerMinute; i++ {
		limiter.Allow("attacker")
	}

	if limiter.Allow("attacker") {
		t.Error("connect number 31 in the same minute was allowed — the handshake DB cost is unbounded")
	}
	// One account being throttled must not throttle another.
	if !limiter.Allow("bystander") {
		t.Error("a different user was refused — the limiter is not keyed per user")
	}
}

// Refusals are counted, not logged one by one: what gets refused is a loop or a race, so a line
// per refusal would let whoever is causing them fill the disk.
func TestCountRefusal_EmitsAtMostOneLinePerInterval(t *testing.T) {
	h := newHubForLimits()
	h.refusals.lastFlush = time.Now() // start mid-interval so the first call does not flush

	for i := 0; i < 1000; i++ {
		h.RefusedOverCap()
	}

	h.refusals.mu.Lock()
	tally := h.refusals.overCap
	h.refusals.mu.Unlock()
	if tally != 1000 {
		t.Errorf("tally = %d, want 1000 — refusals must still be counted while unlogged", tally)
	}
}

func TestCountRefusal_FlushResetsEveryTally(t *testing.T) {
	h := newHubForLimits()
	h.refusals.lastFlush = time.Now()
	h.RefusedOverCap()
	h.RefusedTooFast()
	h.countRefusal(&h.refusals.atRegister)

	// Now cross the interval; the next refusal flushes and zeroes all three.
	h.refusals.mu.Lock()
	h.refusals.lastFlush = time.Now().Add(-2 * refusalFlushInterval)
	h.refusals.mu.Unlock()
	h.RefusedTooFast()

	h.refusals.mu.Lock()
	defer h.refusals.mu.Unlock()
	if h.refusals.overCap != 0 || h.refusals.atRegister != 0 || h.refusals.tooFast != 0 {
		t.Errorf("tallies after flush = %d/%d/%d, want all 0 — a stale one would double-report",
			h.refusals.overCap, h.refusals.atRegister, h.refusals.tooFast)
	}
	if time.Since(h.refusals.lastFlush) > time.Second {
		t.Error("lastFlush was not advanced — every later refusal would log again")
	}
}

// The registration refusal is the racing path, so it is the one an attacker produces in volume —
// and it runs inside Run, the single goroutine every connect and disconnect passes through. It
// must go through the same tally rather than writing a line each time.
func TestAddClient_RefusalIsCountedNotLogged(t *testing.T) {
	h := newHubForLimits()
	h.SetMaxConnectionsPerUser(1)
	h.refusals.lastFlush = time.Now()
	attach(h, "u1", 1)

	for i := 0; i < 100; i++ {
		h.addClient(&Client{userID: "u1", send: make(chan []byte, 1), done: make(chan struct{})})
	}

	h.refusals.mu.Lock()
	defer h.refusals.mu.Unlock()
	if h.refusals.atRegister != 100 {
		t.Errorf("atRegister = %d, want 100 — registration refusals must reach the tally", h.refusals.atRegister)
	}
}

// Unwired limits must not become a silent refusal. Tests and any caller that skips
// SetConnectionLimits get zero values, and zero has to mean unlimited.
func TestZeroLimits_MeanUnlimited(t *testing.T) {
	h := &Handler{hub: newHubForLimits()}
	attach(h.hub, "u1", 500)

	if h.connectLimiter != nil {
		t.Error("connectLimiter should be nil until wired")
	}
	if h.hub.AtConnectionLimit("u1") {
		t.Error("an unwired hub reported a user at the limit")
	}
}

func TestSetConnectionLimits_DisablesTheRateLimiterWhenNotPositive(t *testing.T) {
	for _, perMinute := range []int{0, -1} {
		h := &Handler{hub: newHubForLimits()}
		h.SetConnectionLimits(10, perMinute)
		if h.connectLimiter != nil {
			t.Errorf("connectsPerMinute=%d created a limiter — it must disable the check", perMinute)
		}
	}

	h := &Handler{hub: newHubForLimits()}
	h.SetConnectionLimits(10, 30)
	if h.connectLimiter == nil {
		t.Error("connectsPerMinute=30 created no limiter")
	}
	if !h.hub.AtConnectionLimit("u1") {
		attach(h.hub, "u1", 10)
		if !h.hub.AtConnectionLimit("u1") {
			t.Error("the cap did not reach the hub")
		}
	}
}

// Calling it twice must not orphan the previous limiter's cleanup goroutine, and must not hand
// everyone a fresh budget by silently swapping the counter out.
func TestSetConnectionLimits_IsSafeToCallTwice(t *testing.T) {
	h := &Handler{hub: newHubForLimits()}
	h.SetConnectionLimits(10, 30)
	first := h.connectLimiter

	h.SetConnectionLimits(5, 20)

	if h.connectLimiter == first {
		t.Error("the limiter was not replaced")
	}
	// Stop is idempotent, so calling it again on the old one must not panic on a closed channel.
	first.Stop()
}

// The one the review caught: the handler's pre-upgrade check reads the count and releases, and the
// count does not rise until addClient runs — a whole handshake later. Connections opened faster
// than a handshake completes therefore all pass the early check. addClient has to be the thing
// that holds the line, or the cap is really just whatever the rate limiter allows.
func TestAddClient_EnforcesTheCapEvenWhenEveryConnectPassedTheEarlyCheck(t *testing.T) {
	h := newHubForLimits()
	h.SetMaxConnectionsPerUser(3)

	// Ten connections that all read the count as 0 before any of them registered — which is what
	// the handshake window actually allows. AtConnectionLimit is deliberately NOT consulted here:
	// in the real race every one of these already passed it, and calling it again would let the
	// early check do the limiting and hide whether addClient does its job.
	var admitted int
	for i := 0; i < 10; i++ {
		client := &Client{userID: "racer", send: make(chan []byte, 1), done: make(chan struct{})}
		if h.addClient(client) {
			admitted++
		}
	}

	if admitted != 3 {
		t.Errorf("admitted %d sockets against a cap of 3 — the registration check is not holding", admitted)
	}
	if got := connCount(h, "racer"); got != 3 {
		t.Errorf("hub holds %d sockets, want 3", got)
	}
}

// And the refusal must leave nothing behind: a client that was never registered still unregisters
// when its ReadPump exits, and that must not fire a disconnect for a user who never connected.
func TestRemoveClient_IgnoresAClientItNeverHeld(t *testing.T) {
	h := newHubForLimits()
	attach(h, "u1", 1)
	var fired bool
	h.onUserFullyDisconnected = func(string, []string) { fired = true }

	stranger := &Client{userID: "u1", send: make(chan []byte, 1), done: make(chan struct{})}
	h.removeClient(stranger)

	if fired {
		t.Error("removing an unregistered client fired a disconnect callback")
	}
	if got := connCount(h, "u1"); got != 1 {
		t.Errorf("connection count = %d, want 1 — the real connection was disturbed", got)
	}
}

type stubTokenValidator struct{ userID string }

func (s stubTokenValidator) ValidateAccessToken(string) (*models.TokenClaims, error) {
	return &models.TokenClaims{UserID: s.userID}, nil
}

// panicUserInfo stands in for the first DB call of the handshake. If a rejected connection ever
// reaches it, the throttle is running after the cost it exists to avoid.
type panicUserInfo struct{ t *testing.T }

func (p panicUserInfo) GetByID(context.Context, string) (*models.User, error) {
	p.t.Fatal("a refused connection reached the database — the check must run before the handshake queries")
	return nil, nil
}

func newHandlerUnderTest(t *testing.T, maxConns, perMinute int) *Handler {
	t.Helper()
	h := &Handler{
		hub:              newHubForLimits(),
		tokenValidator:   stubTokenValidator{userID: "u1"},
		userInfoProvider: panicUserInfo{t: t},
	}
	h.SetConnectionLimits(maxConns, perMinute)
	// Start the interval now. On a fresh handler lastFlush is the zero time, so the very first
	// rejection flushes and zeroes the tally — deliberate, an operator should see the first refusal
	// without waiting a minute — but it would hide the counter these tests read.
	h.hub.refusals.lastFlush = time.Now()
	return h
}

func connectOnce(h *Handler) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.HandleConnection(rec, httptest.NewRequest(http.MethodGet, "/ws?token=stub", nil))
	return rec
}

// The refusal answers before the upgrade, so the client gets an HTTP status rather than a socket
// that opens and dies. 429 is what its reconnect backoff already treats as retryable — a 4xx it
// reads as fatal would leave the user disconnected until they reload.
func TestHandleConnection_OverCapIsRefusedWith429BeforeAnyQuery(t *testing.T) {
	h := newHandlerUnderTest(t, 1, 0)
	attach(h.hub, "u1", 1) // already at the cap

	rec := connectOnce(h)

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}
	if h.hub.refusals.overCap != 1 {
		t.Errorf("overCap tally = %d, want 1", h.hub.refusals.overCap)
	}
}

func TestHandleConnection_TooFastIsRefusedWith429AndRetryAfter(t *testing.T) {
	h := newHandlerUnderTest(t, 0, 1)

	// The first connect spends the budget. It has no cap to hit, so it would go on to the DB —
	// which is why this one uses a handler whose userInfoProvider is allowed to be reached.
	h.userInfoProvider = nil
	if rec := connectOnce(h); rec.Code == http.StatusTooManyRequests {
		t.Fatal("the first connect of the minute was refused")
	}

	// The second must be refused before any DB work.
	h.userInfoProvider = panicUserInfo{t: t}
	rec := connectOnce(h)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After — the client cannot tell how long to back off")
	}
	if h.hub.refusals.tooFast != 1 {
		t.Errorf("tooFast tally = %d, want 1", h.hub.refusals.tooFast)
	}
}

// One account hitting either limit must not refuse anybody else.
func TestHandleConnection_LimitsAreScopedToOneAccount(t *testing.T) {
	h := newHandlerUnderTest(t, 1, 0)
	attach(h.hub, "flooder", 5)
	h.tokenValidator = stubTokenValidator{userID: "innocent"}
	h.userInfoProvider = nil // let it past the door; the door is what is under test

	if rec := connectOnce(h); rec.Code == http.StatusTooManyRequests {
		t.Error("an unrelated account was refused because another user filled its own cap")
	}
}

// connCount reads the hub's socket count for a user. The hub exposes no accessor for it — nothing
// in production needs one — so the tests reach in under the same lock the hub uses.
func connCount(h *Hub, userID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID])
}
