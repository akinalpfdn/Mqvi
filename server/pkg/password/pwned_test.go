package password

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const knownPassword = "correct horse battery staple"

func suffixOf(t *testing.T, pw string) string {
	t.Helper()
	sum := sha1.Sum([]byte(pw))
	return strings.ToUpper(hex.EncodeToString(sum[:]))[5:]
}

// stubHIBP answers every range request with the given body, and records what was sent.
func stubHIBP(t *testing.T, status int, body string) (*HIBPChecker, *string) {
	t.Helper()
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(status)
		_, _ = fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)

	return newCheckerWithURL(srv.URL + "/"), &gotPath
}

func TestIsBreachedFindsAMatch(t *testing.T) {
	suffix := suffixOf(t, knownPassword)
	checker, _ := stubHIBP(t, http.StatusOK, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:3\r\n"+suffix+":42\r\n")

	if breached, err := checker.IsBreached(context.Background(), knownPassword); err != nil || !breached {
		t.Error("a suffix present with a non-zero count is a breach")
	}
}

// HIBP pads responses so their size cannot narrow the candidate set. Padded rows are real
// hashes with a count of zero; reading one as a hit would reject a password nobody has leaked.
func TestIsBreachedIgnoresPadding(t *testing.T) {
	suffix := suffixOf(t, knownPassword)
	checker, _ := stubHIBP(t, http.StatusOK, suffix+":0\r\n")

	if breached, _ := checker.IsBreached(context.Background(), knownPassword); breached {
		t.Error("a padded entry (count 0) must not count as a breach")
	}
}

func TestIsBreachedMatchesRegardlessOfCase(t *testing.T) {
	suffix := strings.ToLower(suffixOf(t, knownPassword))
	checker, _ := stubHIBP(t, http.StatusOK, suffix+":7\r\n")

	if breached, err := checker.IsBreached(context.Background(), knownPassword); err != nil || !breached {
		t.Error("the API's hex casing must not decide whether a password is safe")
	}
}

func TestIsBreachedIgnoresOtherSuffixes(t *testing.T) {
	checker, _ := stubHIBP(t, http.StatusOK, "0000000000000000000000000000000000A:9\r\n")

	if breached, _ := checker.IsBreached(context.Background(), knownPassword); breached {
		t.Error("only our own suffix may match")
	}
}

// Only the first five hex characters of the hash may leave this process.
func TestIsBreachedSendsOnlyThePrefix(t *testing.T) {
	checker, gotPath := stubHIBP(t, http.StatusOK, "")
	_, _ = checker.IsBreached(context.Background(), knownPassword)

	sum := sha1.Sum([]byte(knownPassword))
	digest := strings.ToUpper(hex.EncodeToString(sum[:]))

	if *gotPath != "/"+digest[:5] {
		t.Fatalf("requested %q, want %q", *gotPath, "/"+digest[:5])
	}
	if strings.Contains(*gotPath, digest[5:]) {
		t.Error("the hash suffix must never be sent")
	}
}

// Signing up must not hinge on a third party being reachable — but a lookup that never
// happened has to be reported, or an operator cannot tell the corpus went unconsulted.
func TestIsBreachedReportsAFailedLookup(t *testing.T) {
	cases := map[string]func() *HIBPChecker{
		"server error": func() *HIBPChecker {
			c, _ := stubHIBP(t, http.StatusInternalServerError, "")
			return c
		},
		"unreachable": func() *HIBPChecker {
			return newCheckerWithURL("http://127.0.0.1:1/")
		},
	}

	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			breached, err := build().IsBreached(context.Background(), knownPassword)
			if breached {
				t.Error("a failed lookup must not reject the password")
			}
			if err == nil {
				t.Error("a failed lookup must return an error so the caller can record it")
			}
		})
	}

	t.Run("cancelled context", func(t *testing.T) {
		checker, _ := stubHIBP(t, http.StatusOK, "")
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		breached, err := checker.IsBreached(ctx, knownPassword)
		if breached {
			t.Error("a cancelled request must not reject the password")
		}
		if err == nil {
			t.Error("a cancelled request must return an error")
		}
	})
}
