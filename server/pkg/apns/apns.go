// Package apns sends PushKit VoIP pushes to iOS devices via direct APNs HTTP/2.
// Used for incoming calls: FCM cannot deliver VoIP pushes (PushKit uses a separate
// token), so CallKit requires the server to talk to APNs directly with token-based
// (.p8) authentication.
package apns

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	productionHost = "https://api.push.apple.com"
	sandboxHost    = "https://api.sandbox.push.apple.com"
	// jwtRefresh is below Apple's ~60-minute provider-token lifetime; APNs rejects
	// tokens older than 1h and throttles tokens refreshed more than once per ~20m.
	jwtRefresh = 40 * time.Minute
)

// ErrTokenUnregistered means APNs rejected the device token as permanently invalid
// (app uninstalled / bad token) — the caller should prune it.
var ErrTokenUnregistered = errors.New("apns: device token unregistered")

// Config holds token-based APNs auth.
type Config struct {
	KeyPath    string
	KeyID      string
	TeamID     string
	BundleID   string
	Production bool
}

// Sender delivers pushes to iOS devices over APNs.
type Sender interface {
	// SendVoIP posts a VoIP push to deviceToken. Returns ErrTokenUnregistered if APNs
	// reports the token permanently invalid.
	SendVoIP(ctx context.Context, deviceToken string, payload map[string]any) error
	// SendAlert posts a user-visible alert push (messages/DMs) to deviceToken.
	// collapseID, when non-empty, is sent as apns-collapse-id: newer alerts for the same
	// conversation replace the older one, and the delivered notification's identifier
	// becomes collapseID — which is what lets the client find and clear it on read.
	// Returns ErrTokenUnregistered if APNs reports the token permanently invalid.
	SendAlert(ctx context.Context, deviceToken, collapseID string, payload map[string]any) error
	// SendBackground posts a silent content-available push (apns-priority 5). Delivery is
	// best-effort by design: iOS throttles background pushes and never delivers them to a
	// force-quit app. Callers must not rely on it as the only path to a correct state.
	SendBackground(ctx context.Context, deviceToken string, payload map[string]any) error
	Enabled() bool
}

type sender struct {
	cfg    Config
	key    *ecdsa.PrivateKey // nil => disabled
	client     *http.Client
	host       string
	voipTopic  string // <bundle>.voip — PushKit VoIP pushes
	alertTopic string // <bundle> — user-visible alert pushes

	mu    sync.Mutex
	jwt   string
	jwtAt time.Time
}

// NewSender builds a VoIP sender from a .p8 token-auth key. Missing config yields a
// disabled (no-op) sender; an unreadable/invalid key yields a disabled sender plus an
// error to log. Push is optional — the server must still start.
func NewSender(cfg Config) (Sender, error) {
	if cfg.KeyPath == "" || cfg.KeyID == "" || cfg.TeamID == "" || cfg.BundleID == "" {
		return &sender{}, nil
	}
	pemBytes, err := os.ReadFile(cfg.KeyPath)
	if err != nil {
		return &sender{}, nil // file absent -> disabled, not an error (self-host)
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return &sender{}, errors.New("apns: key file is not valid PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return &sender{}, fmt.Errorf("apns: parse key: %w", err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return &sender{}, errors.New("apns: key is not an ECDSA key")
	}

	host := sandboxHost
	if cfg.Production {
		host = productionHost
	}
	return &sender{
		cfg:        cfg,
		key:        key,
		client:     &http.Client{Timeout: 10 * time.Second},
		host:       host,
		voipTopic:  cfg.BundleID + ".voip",
		alertTopic: cfg.BundleID,
	}, nil
}

func (s *sender) Enabled() bool { return s.key != nil }

// authToken returns a cached provider JWT, re-signed before Apple's expiry window.
func (s *sender) authToken() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.jwt != "" && time.Since(s.jwtAt) < jwtRefresh {
		return s.jwt, nil
	}
	now := time.Now()
	t := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": s.cfg.TeamID,
		"iat": now.Unix(),
	})
	t.Header["kid"] = s.cfg.KeyID
	signed, err := t.SignedString(s.key)
	if err != nil {
		return "", fmt.Errorf("apns: sign jwt: %w", err)
	}
	s.jwt, s.jwtAt = signed, now
	return signed, nil
}

func (s *sender) SendVoIP(ctx context.Context, deviceToken string, payload map[string]any) error {
	// Drop the push if undelivered within the ring window so APNs can't ring a call
	// that already timed out / ended (ghost ring).
	expiry := time.Now().Add(60 * time.Second).Unix()
	return s.post(ctx, deviceToken, payload, s.voipTopic, "voip", "", "10", expiry, "voip push")
}

func (s *sender) SendAlert(ctx context.Context, deviceToken, collapseID string, payload map[string]any) error {
	// expiration 0 => APNs stores and retries delivery for offline devices.
	return s.post(ctx, deviceToken, payload, s.alertTopic, "alert", collapseID, "10", 0, "alert push")
}

func (s *sender) SendBackground(ctx context.Context, deviceToken string, payload map[string]any) error {
	// Apple requires priority 5 for background pushes; 10 gets the push rejected.
	// 60s expiry: a stale retraction is worthless — the reconnect sweep covers late devices.
	expiry := time.Now().Add(60 * time.Second).Unix()
	return s.post(ctx, deviceToken, payload, s.alertTopic, "background", "", "5", expiry, "background push")
}

// post signs and delivers a single push over APNs HTTP/2. topic + pushType select the
// delivery kind (VoIP vs alert vs background); expiry 0 leaves the header unset
// (store-and-forward); collapseID "" leaves apns-collapse-id unset.
func (s *sender) post(ctx context.Context, deviceToken string, payload map[string]any, topic, pushType, collapseID, priority string, expiry int64, kind string) error {
	if s.key == nil {
		return nil
	}
	auth, err := s.authToken()
	if err != nil {
		return err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("apns: marshal payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.host+"/3/device/"+deviceToken, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("apns: build request: %w", err)
	}
	req.Header.Set("authorization", "bearer "+auth)
	req.Header.Set("apns-topic", topic)
	req.Header.Set("apns-push-type", pushType)
	req.Header.Set("apns-priority", priority)
	if collapseID != "" {
		req.Header.Set("apns-collapse-id", collapseID)
	}
	if expiry > 0 {
		req.Header.Set("apns-expiration", strconv.FormatInt(expiry, 10))
	}
	req.Header.Set("content-type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("apns: request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		return nil
	}
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	// 410 Gone (Unregistered) or a BadDeviceToken reason => permanently invalid.
	if resp.StatusCode == http.StatusGone || bytes.Contains(respBody, []byte("BadDeviceToken")) {
		return ErrTokenUnregistered
	}
	return fmt.Errorf("apns: %s failed: status %d: %s", kind, resp.StatusCode, respBody)
}
