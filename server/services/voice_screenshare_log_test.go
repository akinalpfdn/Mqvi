package services

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/testutil"
)

// A screen share that fails leaves no trace anywhere the operator can see: the client logs to a
// console nobody has open, and the server returns an error and forgets. These pin the one rule the
// `screen_share` log category has to keep — **a refusal is recorded, a working share is silent** —
// because a category that also logs successes is a category nobody will read.

type captureLogger struct {
	entries []capturedLog
}

type capturedLog struct {
	level    models.LogLevel
	category models.LogCategory
	userID   string
	message  string
	metadata map[string]string
}

func (c *captureLogger) Log(level models.LogLevel, category models.LogCategory, userID, _ *string, message string, metadata map[string]string) {
	uid := ""
	if userID != nil {
		uid = *userID
	}
	c.entries = append(c.entries, capturedLog{level, category, uid, message, metadata})
}

// screenShare returns only the entries filed under that category — the same slice the admin
// panel's filter shows.
func (c *captureLogger) screenShare() []capturedLog {
	out := make([]capturedLog, 0, len(c.entries))
	for _, e := range c.entries {
		if e.category == models.LogCategoryScreenShare {
			out = append(out, e)
		}
	}
	return out
}

func voiceServiceWithLogger() (VoiceService, *captureLogger) {
	svc, _ := newTestVoiceService()
	logger := &captureLogger{}
	svc.SetAppLogger(logger)
	return svc, logger
}

// workingLiveKitGetter returns an instance whose credentials actually decrypt under testKey, so a
// token can be minted end to end. The shared harness's getter errors on purpose, which is fine for
// the refusal cases but would make "a success is silent" assert the wrong thing.
type workingLiveKitGetter struct{ apiKey, apiSecret string }

func (m *workingLiveKitGetter) GetByServerID(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	return &models.LiveKitInstance{ID: "lk1", URL: "wss://lk.test", APIKey: m.apiKey, APISecret: m.apiSecret}, nil
}

// Reached once the channel is bound: the binding stores an id, so every later token re-reads by it.
func (m *workingLiveKitGetter) GetByID(_ context.Context, id string) (*models.LiveKitInstance, error) {
	return &models.LiveKitInstance{ID: id, URL: "wss://lk.test", APIKey: m.apiKey, APISecret: m.apiSecret}, nil
}

func voiceServiceThatCanMint(t *testing.T) (VoiceService, *captureLogger) {
	t.Helper()
	key := make([]byte, 32) // all-zero AES-256 key; only decryptability matters here
	apiKey, err := crypto.Encrypt("devkey", key)
	if err != nil {
		t.Fatalf("encrypt api key: %v", err)
	}
	apiSecret, err := crypto.Encrypt("devsecret", key)
	if err != nil {
		t.Fatalf("encrypt api secret: %v", err)
	}

	logger := &captureLogger{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&workingLiveKitGetter{apiKey: apiKey, apiSecret: apiSecret},
		&testutil.MockChannelPermResolver{},
		&testutil.MockBroadcaster{},
		nil, nil, key, &testutil.MockFileURLSigner{},
	)
	svc.SetAppLogger(logger)
	return svc, logger
}

func TestScreenShareToken_SuccessWritesNothing(t *testing.T) {
	svc, logger := voiceServiceThatCanMint(t)
	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("join: %v", err)
	}

	resp, err := svc.GenerateScreenShareToken(context.Background(), "u1", "alice", "Alice", "ch1")
	if err != nil {
		t.Fatalf("token generation should succeed for a user in the channel: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("expected a signed token — a silent empty response would pass the log assertion for the wrong reason")
	}

	// The whole point of the category. Every working share writing a row would bury the failures.
	if got := logger.screenShare(); len(got) != 0 {
		t.Fatalf("a successful share wrote %d screen_share log(s), want 0: %+v", len(got), got)
	}
}

func TestScreenShareToken_RefusalIsRecordedWithACause(t *testing.T) {
	svc, logger := voiceServiceWithLogger()
	// u1 never joined, so the in-voice check refuses.

	if _, err := svc.GenerateScreenShareToken(context.Background(), "u1", "alice", "Alice", "ch1"); err == nil {
		t.Fatal("expected a refusal for a user who is not in the channel")
	}

	got := logger.screenShare()
	if len(got) != 1 {
		t.Fatalf("got %d screen_share logs, want exactly 1: %+v", len(got), got)
	}
	entry := got[0]
	if entry.userID != "u1" {
		t.Errorf("userID = %q, want u1 — without it the row cannot be traced to a person", entry.userID)
	}
	// A stable code, not prose: the admin log is scanned by cause, and prose drifts.
	if entry.metadata["reason"] != "not_in_voice_channel" {
		t.Errorf("reason = %q, want not_in_voice_channel", entry.metadata["reason"])
	}
	if entry.metadata["channel_id"] != "ch1" {
		t.Errorf("channel_id = %q, want ch1", entry.metadata["channel_id"])
	}
}

// "Not in any voice channel" and "in a different one" fail the same check and mean different
// things. The second would be a real client/server divergence — the reason this logging exists at
// all — so the row has to tell them apart rather than collapsing both into one code.
func TestScreenShareToken_DistinguishesWrongChannelFromNoChannel(t *testing.T) {
	svc, logger := voiceServiceWithLogger()
	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("join: %v", err)
	}

	// In voice, but asking for a different channel.
	if _, err := svc.GenerateScreenShareToken(context.Background(), "u1", "alice", "Alice", "ch2"); err == nil {
		t.Fatal("expected a refusal when the requested channel is not the one the user is in")
	}

	got := logger.screenShare()
	if len(got) != 1 {
		t.Fatalf("got %d screen_share logs, want 1: %+v", len(got), got)
	}
	meta := got[0].metadata
	if meta["in_voice"] != "true" {
		t.Errorf("in_voice = %q, want true — the user IS in voice, just elsewhere", meta["in_voice"])
	}
	if meta["state_channel_id"] != "ch1" {
		t.Errorf("state_channel_id = %q, want ch1 — the channel they are actually in", meta["state_channel_id"])
	}
	if meta["channel_id"] != "ch2" {
		t.Errorf("channel_id = %q, want ch2 — the channel they asked for", meta["channel_id"])
	}
}

func TestScreenShareToken_RefusesAndLogsForATextChannel(t *testing.T) {
	logger := &captureLogger{}
	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeText}, nil
			},
		},
		&mockLiveKitGetter{}, &testutil.MockChannelPermResolver{}, hub,
		nil, nil, nil, &testutil.MockFileURLSigner{},
	)
	svc.SetAppLogger(logger)

	if _, err := svc.GenerateScreenShareToken(context.Background(), "u1", "alice", "Alice", "ch1"); err == nil {
		t.Fatal("expected a refusal for a text channel")
	}

	got := logger.screenShare()
	if len(got) != 1 || got[0].metadata["reason"] != "not_a_voice_channel" {
		t.Fatalf("want one not_a_voice_channel log, got %+v", got)
	}
}

// The logger is optional — nothing may have called SetAppLogger. A refusal must still be a refusal
// and not a nil dereference on the request path.
func TestScreenShareToken_SurvivesWithNoLogger(t *testing.T) {
	svc, _ := newTestVoiceService()

	if _, err := svc.GenerateScreenShareToken(context.Background(), "u1", "alice", "Alice", "ch1"); err == nil {
		t.Fatal("expected a refusal")
	}
}
