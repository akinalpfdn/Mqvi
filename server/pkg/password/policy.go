// Package password holds the one password policy every entry point shares — registration,
// change, and reset.
package password

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// MinLength follows NIST SP 800-63B: a length floor instead of composition rules. Requiring
// a symbol and a digit admits "Ankara2024!", which is already in every breach corpus, and
// rejects "mavi kedi kahve içiyor", which is not.
const MinLength = 12

// MaxBytes is bcrypt's hard ceiling — it errors above 72 bytes, and Turkish letters cost two
// each, so a passphrase can hit it at 36 visible characters. Caught here, or the hash call
// fails and the user gets a 500. Short of NIST's 64-character floor; lifting it means
// pre-hashing before bcrypt, which changes the stored format.
const MaxBytes = 72

// The identity is a problem when the password is made of it, not when it happens to contain
// it: user "ali" must still be able to write "kaliteli sabun kullanırım". So it is rejected
// only when it takes up at least a third of the password (identityShare), or when stripping
// every occurrence leaves less than minResidual behind.
const (
	identityShare = 3
	minResidual   = MinLength / 2
)

var (
	ErrTooShort         = errors.New("password must be at least 12 characters")
	ErrTooLong          = errors.New("password is too long (72 bytes; Turkish letters count as two)")
	ErrContainsIdentity = errors.New("password must not be built out of your username or email")
	ErrBreached         = errors.New("this password has appeared in a data breach, choose another")
)

// Validate applies the offline rules. The breach lookup is separate — it needs the network.
func Validate(password, username, email string) error {
	if utf8.RuneCountInString(password) < MinLength {
		return ErrTooShort
	}
	if len(password) > MaxBytes {
		return ErrTooLong
	}

	if builtFrom(password, username) {
		return ErrContainsIdentity
	}
	// Local part only — rejecting a password for containing "gmail" would be absurd.
	if local, _, found := strings.Cut(email, "@"); found && builtFrom(password, local) {
		return ErrContainsIdentity
	}

	return nil
}

// builtFrom reports whether the password is made of the identity rather than merely containing
// it. Two ways it can be: the identity is a large slice of it, or it is repeated until almost
// nothing else remains.
func builtFrom(password, identity string) bool {
	if identity == "" {
		return false
	}

	lower := strings.ToLower(password)
	id := strings.ToLower(identity)
	if !strings.Contains(lower, id) {
		return false
	}

	if utf8.RuneCountInString(id)*identityShare >= utf8.RuneCountInString(lower) {
		return true
	}
	return utf8.RuneCountInString(strings.ReplaceAll(lower, id, "")) < minResidual
}
