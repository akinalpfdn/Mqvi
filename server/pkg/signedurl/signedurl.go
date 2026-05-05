// Package signedurl provides HMAC-SHA256 signed, time-limited URLs for
// authenticated file access. Stateless — verification requires no DB hit.
package signedurl

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var (
	ErrMissingSig = errors.New("missing signature")
	ErrExpired    = errors.New("URL expired")
	ErrInvalidSig = errors.New("invalid signature")
)

// Signer produces and verifies HMAC-SHA256 signed URLs.
type Signer struct {
	active []byte // current signing key
	prev   []byte // previous key accepted for verification (may be nil)
}

// NewSigner creates a Signer. Keys are raw bytes (decode base64 before calling).
// prev may be nil if no key rotation is in progress.
func NewSigner(active, prev []byte) *Signer {
	return &Signer{active: active, prev: prev}
}

// Sign appends ?exp=<unix>&sig=<base64url> to the given path.
func (s *Signer) Sign(path string, ttl time.Duration) string {
	exp := time.Now().Add(ttl).Unix()
	expStr := strconv.FormatInt(exp, 10)
	sig := s.computeMAC(s.active, path, expStr)
	return path + "?exp=" + expStr + "&sig=" + base64.RawURLEncoding.EncodeToString(sig)
}

// Verify checks that the URL has a valid, non-expired signature.
// fullPath is the path portion (without query string).
func (s *Signer) Verify(fullPath, expStr, sigB64 string) error {
	if sigB64 == "" || expStr == "" {
		return ErrMissingSig
	}

	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return fmt.Errorf("%w: invalid exp value", ErrMissingSig)
	}
	if time.Now().Unix() > exp {
		return ErrExpired
	}

	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return ErrInvalidSig
	}

	// Check active key first, then previous key for rotation window.
	if hmac.Equal(sig, s.computeMAC(s.active, fullPath, expStr)) {
		return nil
	}
	if s.prev != nil && hmac.Equal(sig, s.computeMAC(s.prev, fullPath, expStr)) {
		return nil
	}
	return ErrInvalidSig
}

// VerifyURL is a convenience that extracts exp and sig from a full URL string.
func (s *Signer) VerifyURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ErrInvalidSig
	}
	return s.Verify(u.EscapedPath(), u.Query().Get("exp"), u.Query().Get("sig"))
}

// SignIfNeeded signs the URL only if it starts with the file URL prefix.
// Already-signed URLs (containing ?exp= and &sig=) pass through unchanged (idempotent).
// Legacy /api/uploads/ URLs and non-file URLs pass through unchanged.
// Nil-safe: if s is nil, returns the input unchanged (allows gradual rollout).
func (s *Signer) SignIfNeeded(fileURL string, prefix string, ttl time.Duration) string {
	if s == nil || !strings.HasPrefix(fileURL, prefix+"/") {
		return fileURL
	}
	// Idempotent: if already signed, return as-is
	if strings.Contains(fileURL, "?exp=") && strings.Contains(fileURL, "&sig=") {
		return fileURL
	}
	return s.Sign(fileURL, ttl)
}

// SignPtr is like SignIfNeeded but for *string fields (avatar_url, icon_url, etc.).
func (s *Signer) SignPtr(fileURL *string, prefix string, ttl time.Duration) *string {
	if fileURL == nil || *fileURL == "" {
		return fileURL
	}
	signed := s.SignIfNeeded(*fileURL, prefix, ttl)
	return &signed
}

// computeMAC returns HMAC-SHA256 over "path\nexp".
func (s *Signer) computeMAC(key []byte, path, exp string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(path + "\n" + exp))
	return mac.Sum(nil)
}
