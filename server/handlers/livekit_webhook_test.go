package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"

	"github.com/livekit/protocol/auth"
	livekit "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"google.golang.org/protobuf/encoding/protojson"
)

// capturingLog records what the handler would write to app_logs.
type capturingLog struct {
	entries []logEntry
}

type logEntry struct {
	level    models.LogLevel
	category models.LogCategory
	userID   string
	message  string
	metadata map[string]string
}

func (c *capturingLog) Log(level models.LogLevel, category models.LogCategory, userID, _ *string, message string, metadata map[string]string) {
	uid := ""
	if userID != nil {
		uid = *userID
	}
	c.entries = append(c.entries, logEntry{level, category, uid, message, metadata})
}
func (c *capturingLog) List(context.Context, models.AppLogFilter) ([]models.AppLog, int, error) {
	return nil, 0, nil
}
func (c *capturingLog) Clear(context.Context) error { return nil }
func (c *capturingLog) Start()                      {}
func (c *capturingLog) Stop()                       {}

// stubPresence is a read-only view of voice state. It has no mutating method, and neither does
// VoicePresenceReader — the compiler is the proof that this handler cannot change voice state.
type stubPresence struct {
	states map[string]*models.VoiceState
	calls  int
}

func (s *stubPresence) GetUserVoiceState(userID string) *models.VoiceState {
	s.calls++
	return s.states[userID]
}

type stubKeyLoader struct {
	instances []models.LiveKitInstance
	err       error
}

func (s *stubKeyLoader) ListAllInstances(context.Context) ([]models.LiveKitInstance, error) {
	return s.instances, s.err
}

func leftEvent(room, identity string, reason livekit.DisconnectReason) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{
		Event:       webhook.EventParticipantLeft,
		Room:        &livekit.Room{Name: room},
		Participant: &livekit.ParticipantInfo{Identity: identity, DisconnectReason: reason},
	}
}

func inChannel(userID, channelID string) *stubPresence {
	return &stubPresence{states: map[string]*models.VoiceState{
		userID: {UserID: userID, ChannelID: channelID, ServerID: "s1"},
	}}
}

func single(t *testing.T, log *capturingLog) logEntry {
	t.Helper()
	if len(log.entries) != 1 {
		t.Fatalf("want exactly one log entry, got %d", len(log.entries))
	}
	return log.entries[0]
}

func TestClassifyDisconnect_EveryEnumValueHasAClass(t *testing.T) {
	known := map[disconnectClass]bool{classRemove: true, classIgnore: true, classLogOnly: true}
	for value, name := range livekit.DisconnectReason_name {
		class := classifyDisconnect(livekit.DisconnectReason(value))
		if !known[class] {
			t.Errorf("%s: unknown class %q", name, class)
		}
	}
	// A value this build has never seen must never remove.
	if got := classifyDisconnect(livekit.DisconnectReason(9999)); got != classIgnore {
		t.Errorf("unlisted reason classified as %q, want %q", got, classIgnore)
	}
}

func TestClassifyDisconnect_PinsTheThreeThatMustNotRemove(t *testing.T) {
	// These three happened in production during ordinary reconnects and our own teardown.
	for _, r := range []livekit.DisconnectReason{
		livekit.DisconnectReason_DUPLICATE_IDENTITY,
		livekit.DisconnectReason_MIGRATION,
		livekit.DisconnectReason_PARTICIPANT_REMOVED,
	} {
		if got := classifyDisconnect(r); got == classRemove {
			t.Errorf("%s classified as remove — this reintroduces kicked-for-no-reason", r)
		}
	}
	if got := classifyDisconnect(livekit.DisconnectReason_CLIENT_INITIATED); got != classRemove {
		t.Errorf("CLIENT_INITIATED: got %q, want %q", got, classRemove)
	}
}

func TestLogEvent_LeftForUserInChannel(t *testing.T) {
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(nil, nil, log, inChannel("u1", "c1"))

	h.logEvent(leftEvent("s1:c1", "u1", livekit.DisconnectReason_CLIENT_INITIATED))

	e := single(t, log)
	if e.userID != "u1" || e.level != models.LogLevelInfo || e.category != models.LogCategoryLiveKit {
		t.Fatalf("unexpected entry: %+v", e)
	}
	want := map[string]string{
		"server_id": "s1", "channel_id": "c1", "server_view": viewInChannel, "mismatch": "false",
		"reason_class": string(classRemove), "is_screen_share": "false",
	}
	for k, v := range want {
		if e.metadata[k] != v {
			t.Errorf("metadata[%s] = %q, want %q", k, e.metadata[k], v)
		}
	}
	if !strings.Contains(e.message, "class: remove") || !strings.Contains(e.message, "[server: in_channel]") {
		t.Errorf("message does not carry class and view for plain-text search: %q", e.message)
	}
}

func TestLogEvent_LeftForUserTheServerDoesNotHave(t *testing.T) {
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(nil, nil, log, &stubPresence{})

	h.logEvent(leftEvent("s1:c1", "u1", livekit.DisconnectReason_CONNECTION_TIMEOUT))

	e := single(t, log)
	if e.metadata["server_view"] != viewNotInVoice || e.metadata["mismatch"] != "true" {
		t.Errorf("want not_in_voice + mismatch, got %v", e.metadata)
	}
	if e.metadata["reason_class"] != string(classLogOnly) || e.level != models.LogLevelWarn {
		t.Errorf("CONNECTION_TIMEOUT: class=%q level=%v", e.metadata["reason_class"], e.level)
	}
}

func TestLogEvent_UserInAnotherChannel(t *testing.T) {
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(nil, nil, log, inChannel("u1", "c9"))

	h.logEvent(leftEvent("s1:c1", "u1", livekit.DisconnectReason_CLIENT_INITIATED))

	e := single(t, log)
	if e.metadata["server_view"] != viewOtherChannel || e.metadata["mismatch"] != "true" {
		t.Errorf("want other_channel + mismatch, got %v", e.metadata)
	}
}

func TestLogEvent_ScreenShareResolvesToItsOwner(t *testing.T) {
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(nil, nil, log, inChannel("u1", "c1"))

	h.logEvent(leftEvent("s1:c1", "u1_ss", livekit.DisconnectReason_CLIENT_INITIATED))

	e := single(t, log)
	if e.userID != "u1" {
		t.Errorf("logged under %q; the _ss identity must resolve to its owner", e.userID)
	}
	if e.metadata["is_screen_share"] != "true" || e.metadata["server_view"] != viewInChannel {
		t.Errorf("screen share metadata wrong: %v", e.metadata)
	}
	if !strings.HasPrefix(e.message, "screen share left") {
		t.Errorf("a sub-participant leaving must not read as the user leaving: %q", e.message)
	}
}

func TestLogEvent_MalformedRoomIsRecordedNotGuessed(t *testing.T) {
	presence := inChannel("u1", "c1")
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(nil, nil, log, presence)

	for _, room := range []string{"garbage", "", "a:b:c", ":c1"} {
		h.logEvent(leftEvent(room, "u1", livekit.DisconnectReason_CLIENT_INITIATED))
	}

	if len(log.entries) != 4 {
		t.Fatalf("want 4 entries, got %d", len(log.entries))
	}
	for _, e := range log.entries {
		if e.metadata["room_malformed"] != "true" || e.level != models.LogLevelWarn {
			t.Errorf("malformed room not flagged: %v", e.metadata)
		}
		if _, ok := e.metadata["server_id"]; ok {
			t.Errorf("server_id guessed from a malformed room: %v", e.metadata)
		}
		if _, ok := e.metadata["server_view"]; ok {
			t.Errorf("server compared against a room it could not parse: %v", e.metadata)
		}
	}
	if presence.calls != 0 {
		t.Errorf("voice service consulted %d times for unparseable rooms", presence.calls)
	}
}

func TestLogEvent_NilPresenceSkipsTheComparison(t *testing.T) {
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(nil, nil, log, nil)

	h.logEvent(leftEvent("s1:c1", "u1", livekit.DisconnectReason_CLIENT_INITIATED))

	e := single(t, log)
	if _, ok := e.metadata["server_view"]; ok {
		t.Errorf("no presence reader wired, yet a view was recorded: %v", e.metadata)
	}
	if e.metadata["reason_class"] != string(classRemove) {
		t.Errorf("classification must not depend on presence: %v", e.metadata)
	}
}

func TestLogEvent_JoinedRecordsTheServerViewToo(t *testing.T) {
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(nil, nil, log, &stubPresence{})

	h.logEvent(&livekit.WebhookEvent{
		Event:       webhook.EventParticipantJoined,
		Room:        &livekit.Room{Name: "s1:c1"},
		Participant: &livekit.ParticipantInfo{Identity: "u1"},
	})

	e := single(t, log)
	if e.metadata["mismatch"] != "true" || e.metadata["server_view"] != viewNotInVoice {
		t.Errorf("a join the server has not seen yet is data, not noise: %v", e.metadata)
	}
	if _, ok := e.metadata["reason_class"]; ok {
		t.Errorf("a join has no disconnect reason to classify: %v", e.metadata)
	}
}

func TestLogEvent_IgnoresEverythingButParticipantEvents(t *testing.T) {
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(nil, nil, log, inChannel("u1", "c1"))

	h.logEvent(&livekit.WebhookEvent{Event: webhook.EventRoomStarted, Room: &livekit.Room{Name: "s1:c1"}})
	h.logEvent(&livekit.WebhookEvent{Event: webhook.EventParticipantLeft, Room: &livekit.Room{Name: "s1:c1"}}) // no participant

	if len(log.entries) != 0 {
		t.Errorf("want no entries, got %d", len(log.entries))
	}
}

// signedRequest builds a POST the way url_notifier does: the body's sha256 goes into a JWT signed
// with the instance's api key/secret, sent as the Authorization header.
func signedRequest(t *testing.T, apiKey, apiSecret string, body []byte) *http.Request {
	t.Helper()
	sum := sha256.Sum256(body)
	jwt, err := auth.NewAccessToken(apiKey, apiSecret).SetValidFor(5 * time.Minute).SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/livekit/webhook", bytes.NewReader(body))
	req.Header.Set("Authorization", jwt)
	return req
}

func TestHandleWebhook_VerifiesAgainstEveryInstanceKeyAndLogs(t *testing.T) {
	encKey := bytes.Repeat([]byte("k"), 32)
	encAPIKey, err := crypto.Encrypt("APIkeyabc", encKey)
	if err != nil {
		t.Fatal(err)
	}
	encSecret, err := crypto.Encrypt("secret-1", encKey)
	if err != nil {
		t.Fatal(err)
	}
	loader := &stubKeyLoader{instances: []models.LiveKitInstance{{ID: "lk1", APIKey: encAPIKey, APISecret: encSecret}}}
	log := &capturingLog{}
	h := NewLiveKitWebhookHandler(loader, encKey, log, inChannel("u1", "c1"))

	body, err := protojson.Marshal(leftEvent("s1:c1", "u1", livekit.DisconnectReason_CLIENT_INITIATED))
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.HandleWebhook(rec, signedRequest(t, "APIkeyabc", "secret-1", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	if e := single(t, log); e.metadata["server_view"] != viewInChannel {
		t.Errorf("event did not reach the comparison: %v", e.metadata)
	}

	// Wrong secret, same body: the HMAC is the only authentication this endpoint has.
	rec = httptest.NewRecorder()
	h.HandleWebhook(rec, signedRequest(t, "APIkeyabc", "not-the-secret", body))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("forged signature accepted: status %d", rec.Code)
	}
	if len(log.entries) != 1 {
		t.Errorf("forged webhook produced a log entry")
	}
}
