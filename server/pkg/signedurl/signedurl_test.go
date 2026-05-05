package signedurl

import (
	"errors"
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
