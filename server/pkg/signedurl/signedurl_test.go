package signedurl

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func testKey() []byte {
	return []byte("0123456789abcdef0123456789abcdef") // 32 bytes
}

func TestSign_Verify_RoundTrip(t *testing.T) {
	s := NewSigner(testKey(), nil)
	signed := s.Sign("/api/files/messages/m1/a.png", time.Hour)

	if err := s.VerifyURL(signed); err != nil {
		t.Fatalf("valid signed URL rejected: %v", err)
	}
}

func TestVerify_TamperedPath(t *testing.T) {
	s := NewSigner(testKey(), nil)
	signed := s.Sign("/api/files/messages/m1/a.png", time.Hour)

	// Replace path portion
	tampered := "/api/files/messages/m1/EVIL.png" + signed[len("/api/files/messages/m1/a.png"):]
	if err := s.VerifyURL(tampered); !errors.Is(err, ErrInvalidSig) {
		t.Fatalf("tampered path accepted: %v", err)
	}
}

func TestVerify_TamperedSig(t *testing.T) {
	s := NewSigner(testKey(), nil)
	signed := s.Sign("/api/files/messages/m1/a.png", time.Hour)

	// Flip last char of sig
	tampered := signed[:len(signed)-1] + "X"
	if err := s.VerifyURL(tampered); !errors.Is(err, ErrInvalidSig) {
		t.Fatalf("tampered sig accepted: %v", err)
	}
}

func TestVerify_Expired(t *testing.T) {
	s := NewSigner(testKey(), nil)
	signed := s.Sign("/api/files/messages/m1/a.png", -time.Second)

	if err := s.VerifyURL(signed); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired URL not rejected: %v", err)
	}
}

func TestVerify_MissingSigOrExp(t *testing.T) {
	s := NewSigner(testKey(), nil)

	if err := s.Verify("/path", "", ""); !errors.Is(err, ErrMissingSig) {
		t.Fatalf("missing sig/exp not rejected: %v", err)
	}
	if err := s.Verify("/path", "9999999999", ""); !errors.Is(err, ErrMissingSig) {
		t.Fatalf("missing sig not rejected: %v", err)
	}
}

func TestVerify_KeyRotation(t *testing.T) {
	oldKey := []byte("old-key-0123456789abcdef01234567")
	newKey := []byte("new-key-0123456789abcdef01234567")

	// Sign with old key
	oldSigner := NewSigner(oldKey, nil)
	signed := oldSigner.Sign("/api/files/dm/d1/x.pdf", time.Hour)

	// Verify with new signer that has old key as prev
	rotatedSigner := NewSigner(newKey, oldKey)
	if err := rotatedSigner.VerifyURL(signed); err != nil {
		t.Fatalf("old-key URL rejected during rotation: %v", err)
	}

	// New signer without prev should reject old-key URL
	newOnlySigner := NewSigner(newKey, nil)
	if err := newOnlySigner.VerifyURL(signed); !errors.Is(err, ErrInvalidSig) {
		t.Fatalf("old-key URL accepted without rotation: %v", err)
	}
}

func TestVerify_EmptyKey(t *testing.T) {
	s := NewSigner([]byte{}, nil)
	signed := s.Sign("/path", time.Hour)
	// Even with empty key, round-trip should work (HMAC handles zero-length key)
	if err := s.VerifyURL(signed); err != nil {
		t.Fatalf("empty key round-trip failed: %v", err)
	}
}

// ─── SignIfNeeded ───
//
// Long-lived caches (voice state, friend lists) call SignIfNeeded every time
// they re-broadcast a URL. The contract is:
//   - unsigned-but-prefixed → fresh signature
//   - signed + plenty of life → idempotent pass-through
//   - signed + near/past expiry → fresh signature (refresh)
//   - signed but tampered → pass-through unchanged (NEVER launder)
//   - non-prefix URL → pass-through unchanged

const filePrefix = "/api/files"

func TestSignIfNeeded_FreshlySignsUnsignedURL(t *testing.T) {
	s := NewSigner(testKey(), nil)
	out := s.SignIfNeeded("/api/files/messages/m1/a.png", filePrefix, time.Hour)
	if err := s.VerifyURL(out); err != nil {
		t.Fatalf("freshly signed URL not valid: %v", err)
	}
}

func TestSignIfNeeded_IdempotentForFreshSignature(t *testing.T) {
	s := NewSigner(testKey(), nil)
	signed := s.Sign("/api/files/messages/m1/a.png", time.Hour)
	out := s.SignIfNeeded(signed, filePrefix, time.Hour)
	if out != signed {
		t.Fatalf("fresh signed URL was modified: in=%q out=%q", signed, out)
	}
}

func TestSignIfNeeded_RefreshesNearExpiry(t *testing.T) {
	s := NewSigner(testKey(), nil)
	// 30 minutes left vs. ttl=1h → less than ttl/2, must refresh.
	signed := s.Sign("/api/files/messages/m1/a.png", 30*time.Minute)
	out := s.SignIfNeeded(signed, filePrefix, time.Hour)
	if out == signed {
		t.Fatalf("near-expiry URL was not refreshed")
	}
	if err := s.VerifyURL(out); err != nil {
		t.Fatalf("refreshed URL not valid: %v", err)
	}
}

func TestSignIfNeeded_RefreshesExpired(t *testing.T) {
	s := NewSigner(testKey(), nil)
	signed := s.Sign("/api/files/messages/m1/a.png", -time.Second) // already expired
	out := s.SignIfNeeded(signed, filePrefix, time.Hour)
	if out == signed {
		t.Fatalf("expired URL was not refreshed")
	}
	if err := s.VerifyURL(out); err != nil {
		t.Fatalf("refreshed-from-expired URL not valid: %v", err)
	}
}

func TestSignIfNeeded_DoesNotLaunderTamperedSig(t *testing.T) {
	s := NewSigner(testKey(), nil)
	signed := s.Sign("/api/files/messages/m1/a.png", -time.Second) // expired
	// Flip last char of sig to corrupt it.
	tampered := signed[:len(signed)-1] + "X"
	out := s.SignIfNeeded(tampered, filePrefix, time.Hour)
	// MUST be returned unchanged — re-signing would mint a valid credential
	// for an attacker-supplied URL.
	if out != tampered {
		t.Fatalf("tampered URL was laundered: in=%q out=%q", tampered, out)
	}
	if err := s.VerifyURL(out); err == nil {
		t.Fatalf("laundered URL accepted by Verify — sec hole")
	}
}

func TestSignIfNeeded_DoesNotLaunderForeignKeySig(t *testing.T) {
	mine := NewSigner(testKey(), nil)
	other := NewSigner([]byte("DIFFERENT-KEY-0123456789abcdef01"), nil)
	// URL signed by another deployment's key — must not be re-signed by us.
	foreign := other.Sign("/api/files/messages/m1/a.png", time.Hour)
	out := mine.SignIfNeeded(foreign, filePrefix, time.Hour)
	if out != foreign {
		t.Fatalf("foreign-key URL was laundered: in=%q out=%q", foreign, out)
	}
}

func TestSignIfNeeded_AcceptsPrevKeyDuringRotation(t *testing.T) {
	old := []byte("old-key-0123456789abcdef01234567")
	new_ := []byte("new-key-0123456789abcdef01234567")
	oldSigner := NewSigner(old, nil)
	rotated := NewSigner(new_, old)

	// Old-key URL is still authentic during rotation: must be refreshed,
	// not laundered, not passed through as expired.
	signed := oldSigner.Sign("/api/files/messages/m1/a.png", -time.Second) // expired
	out := rotated.SignIfNeeded(signed, filePrefix, time.Hour)
	if out == signed {
		t.Fatalf("old-key expired URL not refreshed during rotation")
	}
	if err := rotated.VerifyURL(out); err != nil {
		t.Fatalf("rotated-key refresh not valid: %v", err)
	}
}

func TestSignIfNeeded_NonPrefixPassthrough(t *testing.T) {
	s := NewSigner(testKey(), nil)
	// /api/uploads/ is the legacy path — must not be signed by this helper.
	in := "/api/uploads/legacy.png"
	out := s.SignIfNeeded(in, filePrefix, time.Hour)
	if out != in {
		t.Fatalf("non-prefix URL modified: in=%q out=%q", in, out)
	}
}

func TestSignIfNeeded_NilSignerPassthrough(t *testing.T) {
	var s *Signer
	in := "/api/files/messages/m1/a.png"
	out := s.SignIfNeeded(in, filePrefix, time.Hour)
	if out != in {
		t.Fatalf("nil signer modified URL: in=%q out=%q", in, out)
	}
}

func TestSignIfNeeded_StripsExtraQueryBeforeSigning(t *testing.T) {
	s := NewSigner(testKey(), nil)
	// Defensive: an unsigned URL with stray query params must not produce a
	// double-? output. The signer strips before re-signing.
	in := "/api/files/messages/m1/a.png?foo=bar&baz=qux"
	out := s.SignIfNeeded(in, filePrefix, time.Hour)
	// Output must verify, must not contain the stray params.
	if err := s.VerifyURL(out); err != nil {
		t.Fatalf("signed-with-stray-query URL did not verify: %v out=%q", err, out)
	}
	if strings.Contains(out, "foo=bar") || strings.Contains(out, "baz=qux") {
		t.Fatalf("stray query params survived signing: %q", out)
	}
}
