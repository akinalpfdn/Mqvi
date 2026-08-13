package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/ratelimit"
)

// stubVoiceService implements the narrow voiceHandlerService interface for
// testing the VoiceStates handler in isolation. Only GetAllVoiceStates returns
// data; the token methods are unused in this test.
type stubVoiceService struct {
	all []models.VoiceState
}

func (s *stubVoiceService) GenerateToken(_ context.Context, _, _, _, _ string) (*models.VoiceTokenResponse, error) {
	return nil, nil
}
func (s *stubVoiceService) GenerateScreenShareToken(_ context.Context, _, _, _, _ string) (*models.VoiceTokenResponse, error) {
	return nil, nil
}
func (s *stubVoiceService) GetAllVoiceStates() []models.VoiceState { return s.all }

// passthroughSigner is a FileURLSigner that returns its input unchanged so
// tests assert on the path, not on signature artifacts.
type passthroughSigner struct{}

func (passthroughSigner) SignURL(s string) string         { return s }
func (passthroughSigner) SignURLPtr(p *string) *string    { return p }

func TestVoiceStates_FiltersByServerID(t *testing.T) {
	all := []models.VoiceState{
		{UserID: "u1", ServerID: "server-a", ChannelID: "c1"},
		{UserID: "u2", ServerID: "server-b", ChannelID: "c2"},
		{UserID: "u3", ServerID: "server-a", ChannelID: "c3"},
		{UserID: "u4", ServerID: "server-c", ChannelID: "c4"},
	}
	h := &VoiceHandler{voiceService: &stubVoiceService{all: all}, urlSigner: passthroughSigner{}}

	req := httptest.NewRequest(http.MethodGet, "/api/servers/server-a/voice/states", nil)
	req.SetPathValue("serverId", "server-a")
	rr := httptest.NewRecorder()
	h.VoiceStates(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	var env struct {
		Success bool                 `json:"success"`
		Data    []models.VoiceState  `json:"data"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	got := env.Data
	if len(got) != 2 {
		t.Fatalf("expected 2 states (server-a only), got %d: %+v", len(got), got)
	}
	for _, st := range got {
		if st.ServerID != "server-a" {
			t.Errorf("leak: state for server %q returned in server-a query", st.ServerID)
		}
	}
}

func TestVoiceStates_RejectsMissingServerID(t *testing.T) {
	h := &VoiceHandler{voiceService: &stubVoiceService{}, urlSigner: passthroughSigner{}}

	req := httptest.NewRequest(http.MethodGet, "/api/servers//voice/states", nil)
	req.SetPathValue("serverId", "")
	rr := httptest.NewRecorder()
	h.VoiceStates(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing serverId, got %d", rr.Code)
	}
}

func TestVoiceStates_EmptyServerReturnsEmpty(t *testing.T) {
	all := []models.VoiceState{
		{UserID: "u1", ServerID: "server-a"},
	}
	h := &VoiceHandler{voiceService: &stubVoiceService{all: all}, urlSigner: passthroughSigner{}}

	req := httptest.NewRequest(http.MethodGet, "/api/servers/server-x/voice/states", nil)
	req.SetPathValue("serverId", "server-x")
	rr := httptest.NewRecorder()
	h.VoiceStates(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	var env struct {
		Success bool                 `json:"success"`
		Data    []models.VoiceState  `json:"data"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	got := env.Data
	if len(got) != 0 {
		t.Fatalf("expected empty slice for server with no voice states, got %+v", got)
	}
}

// signingSigner records each path it signs so the test can assert AvatarURL
// goes through the signer at egress.
type signingSigner struct{ signed []string }

func (s *signingSigner) SignURL(in string) string {
	s.signed = append(s.signed, in)
	return in + "?signed=1"
}
func (s *signingSigner) SignURLPtr(p *string) *string {
	if p == nil {
		return nil
	}
	out := s.SignURL(*p)
	return &out
}

func TestVoiceStates_SignsAvatarOnEgress(t *testing.T) {
	all := []models.VoiceState{
		{UserID: "u1", ServerID: "s", AvatarURL: "/api/files/avatars/u1/a.png"},
	}
	signer := &signingSigner{}
	h := &VoiceHandler{voiceService: &stubVoiceService{all: all}, urlSigner: signer}

	req := httptest.NewRequest(http.MethodGet, "/api/servers/s/voice/states", nil)
	req.SetPathValue("serverId", "s")
	rr := httptest.NewRecorder()
	h.VoiceStates(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if len(signer.signed) != 1 || signer.signed[0] != "/api/files/avatars/u1/a.png" {
		t.Fatalf("expected SignURL called once with raw avatar path, got %v", signer.signed)
	}
	var env struct {
		Success bool                 `json:"success"`
		Data    []models.VoiceState  `json:"data"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	got := env.Data
	if len(got) != 1 || got[0].AvatarURL != "/api/files/avatars/u1/a.png?signed=1" {
		t.Fatalf("expected avatar to carry signer output, got %+v", got)
	}
}

// ─── Screen-share token rate limit ───

// Nothing bounded this endpoint. Every call costs either a 4-hour JWT and possibly the room's E2EE
// passphrase, or — since refusals are now recorded — an app_logs row. On a platform with a real
// user count that is a member-reachable way to bury the operational log the refusals exist to fill.

// countingVoiceService records how many times the service was reached, so a test can prove the
// limiter answered instead of the service.
type countingVoiceService struct {
	stubVoiceService
	tokenCalls int
	err        error
}

func (s *countingVoiceService) GenerateScreenShareToken(_ context.Context, _, _, _, _ string) (*models.VoiceTokenResponse, error) {
	s.tokenCalls++
	if s.err != nil {
		return nil, s.err
	}
	return &models.VoiceTokenResponse{Token: "t", URL: "wss://lk", ChannelID: "ch1"}, nil
}

func screenShareRequest(h *VoiceHandler, userID string) *httptest.ResponseRecorder {
	body := strings.NewReader(`{"channel_id":"ch1"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/servers/s1/voice/screen-token", body)
	req.SetPathValue("serverId", "s1")
	req = req.WithContext(context.WithValue(req.Context(), ctxkeys.User, &models.User{ID: userID, Username: "u"}))
	rec := httptest.NewRecorder()
	h.ScreenShareToken(rec, req)
	return rec
}

func TestScreenShareToken_RefusesOverTheLimit(t *testing.T) {
	svc := &countingVoiceService{}
	h := &VoiceHandler{
		voiceService:  svc,
		urlSigner:     passthroughSigner{},
		screenShareRL: ratelimit.NewMessageRateLimiter(3, time.Minute, time.Minute),
	}

	for i := 0; i < 3; i++ {
		if rec := screenShareRequest(h, "spammer"); rec.Code != http.StatusOK {
			t.Fatalf("request %d: got %d, want 200 — the allowance must be usable", i+1, rec.Code)
		}
	}

	rec := screenShareRequest(h, "spammer")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After — a client cannot tell how long to back off")
	}
	if svc.tokenCalls != 3 {
		t.Errorf("service was reached %d times, want 3 — the 4th must not mint a token", svc.tokenCalls)
	}
}

// The whole point of gating before the service rather than after it: a member who is not in the
// channel gets refused by the service, and each of those refusals writes a log row. If rejected
// requests did not spend the budget, that path would stay floodable at request rate.
func TestScreenShareToken_RejectedRequestsSpendTheBudgetToo(t *testing.T) {
	svc := &countingVoiceService{err: errors.New("must be in the voice channel to screen share")}
	h := &VoiceHandler{
		voiceService:  svc,
		urlSigner:     passthroughSigner{},
		screenShareRL: ratelimit.NewMessageRateLimiter(3, time.Minute, time.Minute),
	}

	for i := 0; i < 3; i++ {
		screenShareRequest(h, "spammer")
	}

	if rec := screenShareRequest(h, "spammer"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429 — failing requests must count", rec.Code)
	}
	if svc.tokenCalls != 3 {
		t.Errorf("service reached %d times, want 3 — the 4th must be stopped before it can log", svc.tokenCalls)
	}
}

func TestScreenShareToken_LimitIsPerUser(t *testing.T) {
	svc := &countingVoiceService{}
	h := &VoiceHandler{
		voiceService:  svc,
		urlSigner:     passthroughSigner{},
		screenShareRL: ratelimit.NewMessageRateLimiter(2, time.Minute, time.Minute),
	}

	screenShareRequest(h, "noisy")
	screenShareRequest(h, "noisy")
	if rec := screenShareRequest(h, "noisy"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("noisy user got %d, want 429", rec.Code)
	}

	// One member burning their allowance must not stop anyone else from sharing.
	if rec := screenShareRequest(h, "innocent"); rec.Code != http.StatusOK {
		t.Fatalf("unrelated user got %d, want 200", rec.Code)
	}
}

// The limiter is optional on the struct. A handler built without one still has to work.
func TestScreenShareToken_WorksWithNoLimiter(t *testing.T) {
	svc := &countingVoiceService{}
	h := &VoiceHandler{voiceService: svc, urlSigner: passthroughSigner{}}

	for i := 0; i < 5; i++ {
		if rec := screenShareRequest(h, "u1"); rec.Code != http.StatusOK {
			t.Fatalf("request %d: got %d, want 200", i+1, rec.Code)
		}
	}
}
