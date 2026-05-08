package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akinalp/mqvi/models"
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
