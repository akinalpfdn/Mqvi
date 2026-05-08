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

	if !s.signatureMatches(fullPath, expStr, sigB64) {
		return ErrInvalidSig
	}
	return nil
}

// signatureMatches returns true iff sigB64 is a valid HMAC over (fullPath, expStr)
// under the active OR previous key. Pure cryptographic check — does NOT inspect
// expiry. Used by SignIfNeeded to distinguish "URL we issued, just stale" from
// "tampered URL we must not launder by issuing a fresh signature".
func (s *Signer) signatureMatches(fullPath, expStr, sigB64 string) bool {
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return false
	}
	if hmac.Equal(sig, s.computeMAC(s.active, fullPath, expStr)) {
		return true
	}
	if s.prev != nil && hmac.Equal(sig, s.computeMAC(s.prev, fullPath, expStr)) {
		return true
	}
	return false
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
// Legacy /api/uploads/ URLs and non-file URLs pass through unchanged.
// Nil-safe: if s is nil, returns the input unchanged (allows gradual rollout).
//
// Decision tree for a URL with the right prefix:
//   - No exp/sig → fresh sign.
//   - Existing exp/sig is a valid HMAC under the active or previous key:
//   - More than ttl/2 of life left → return as-is (idempotent).
//   - Less than ttl/2 left, including already expired → re-sign with fresh exp.
//   - Existing exp/sig FAILS HMAC check (tampered, foreign key, garbage) →
//     return as-is. We MUST NOT re-sign because that would launder a tampered
//     URL into a valid credential. The serve handler will reject it at runtime.
//
// URL parsing is parser-based (net/url), so query order, extra params, or
// percent-encoded variants do not bypass the check.
func (s *Signer) SignIfNeeded(fileURL string, prefix string, ttl time.Duration) string {
	if s == nil || !strings.HasPrefix(fileURL, prefix+"/") {
		return fileURL
	}

	u, err := url.Parse(fileURL)
	if err != nil {
		// Unparseable input — leave as-is, let the serve handler reject it.
		return fileURL
	}
	q := u.Query()
	expStr := q.Get("exp")
	sigB64 := q.Get("sig")

	if expStr != "" && sigB64 != "" {
		// Sig present: must be cryptographically valid before we touch it.
		// An invalid signature is returned untouched — re-signing it would
		// launder a tampered URL into a valid credential.
		if !s.signatureMatches(u.EscapedPath(), expStr, sigB64) {
			return fileURL
		}
		// Authentic signature — refresh only if past or near expiry.
		exp, err := strconv.ParseInt(expStr, 10, 64)
		if err != nil {
			return fileURL
		}
		if remaining := time.Until(time.Unix(exp, 0)); remaining > ttl/2 {
			return fileURL
		}
	}

	// Strip ALL query before signing — Sign appends "?exp=...&sig=...", so any
	// surviving params would produce a malformed double-? URL.
	u.RawQuery = ""
	return s.Sign(u.String(), ttl)
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
