package password

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestValidate(t *testing.T) {
	tests := []struct {
		name     string
		password string
		username string
		email    string
		want     error
	}{
		{"a passphrase with no character classes at all", "mavi kedi kahve iciyor", "ali", "ali@example.com", nil},
		{"exactly the minimum", "abcdefghijkl", "zzz", "", nil},

		{"one rune short", "abcdefghijk", "zzz", "", ErrTooShort},
		// A byte-based length check would take four Turkish characters for eight. That was the
		// bug in the old change-password path.
		{"multibyte runes are counted as runes", "şşşşşşşşşşş", "zzz", "", ErrTooShort},

		// bcrypt errors above 72 bytes, and the sign-up hint steers people toward passphrases.
		{"at the byte ceiling", strings.Repeat("a", 72), "zzz", "", nil},
		{"one byte over", strings.Repeat("a", 73), "zzz", "", ErrTooLong},
		{"turkish letters cost two bytes each", strings.Repeat("şğıç", 10), "zzz", "", ErrTooLong},

		{"the password is the username plus filler", "patrick_pass", "patrick", "", ErrContainsIdentity},
		{"case does not hide it", "PATRICK_pass", "patrick", "", ErrContainsIdentity},
		{"the username is a third of the password", "my-testuser-password", "testuser", "", ErrContainsIdentity},
		{"repeated until nothing else is left", "alialialialiali", "ali", "", ErrContainsIdentity},
		// A three-letter username turns up inside ordinary words. Rejecting a good passphrase
		// over that would be absurd, and length plus the breach corpus carry the weight anyway.
		{"the username merely occurs inside a word", "kaliteli sabun kullanirim", "ali", "", nil},
		{"and again, in another word", "kayak yapmayi cok severim", "kaya", "", nil},

		{"the password is the email local part plus filler", "patrick99_xx", "zzz", "patrick99@example.com", ErrContainsIdentity},
		{"the domain is not the identity", "gmail is a mail service", "zzz", "someone@gmail.com", nil},

		{"empty username never matches", "abcdefghijkl", "", "", nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := Validate(tt.password, tt.username, tt.email); !errors.Is(err, tt.want) {
				t.Errorf("Validate() = %v, want %v", err, tt.want)
			}
		})
	}
}

// The ceiling exists because bcrypt refuses longer input. If bcrypt's limit ever moves, this
// fails rather than letting a password through to a 500.
func TestMaxBytesMatchesBcrypt(t *testing.T) {
	if _, err := bcrypt.GenerateFromPassword([]byte(strings.Repeat("a", MaxBytes)), bcrypt.MinCost); err != nil {
		t.Fatalf("bcrypt rejected a password at MaxBytes (%d): %v", MaxBytes, err)
	}
	if _, err := bcrypt.GenerateFromPassword([]byte(strings.Repeat("a", MaxBytes+1)), bcrypt.MinCost); err == nil {
		t.Fatalf("bcrypt accepted %d bytes — MaxBytes is lower than it needs to be", MaxBytes+1)
	}
}
