package models

import (
	"fmt"
	"regexp"
)

// clientNoncePattern bounds what a client may send as its per-message idempotency key: enough for
// a uuid or a random base64url string, nothing that needs escaping anywhere it is echoed.
var clientNoncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// validateClientNonce accepts an absent nonce (older clients) or a well-formed one.
func validateClientNonce(nonce string) error {
	if nonce != "" && !clientNoncePattern.MatchString(nonce) {
		return fmt.Errorf("client_nonce must be 8-64 characters of A-Z, a-z, 0-9, _ or -")
	}
	return nil
}
