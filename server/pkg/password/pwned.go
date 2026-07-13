package password

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// BreachChecker reports whether a password appears in a known breach corpus. A non-nil error
// means the lookup could not be made — the caller decides what to do about that, and is
// expected to allow the password rather than block signups on a third party being up.
type BreachChecker interface {
	IsBreached(ctx context.Context, password string) (bool, error)
}

const (
	hibpRangeURL = "https://api.pwnedpasswords.com/range/"
	hibpTimeout  = 3 * time.Second
)

// HIBPChecker queries Have I Been Pwned's range API, which never sees the password: only the
// first five hex characters of its SHA-1 leave this process, and the candidate suffixes that
// come back are compared here. Add-Padding stops the response size from narrowing that set.
type HIBPChecker struct {
	client  *http.Client
	baseURL string
}

func NewHIBPChecker() *HIBPChecker {
	return &HIBPChecker{
		client:  &http.Client{Timeout: hibpTimeout},
		baseURL: hibpRangeURL,
	}
}

// newCheckerWithURL points the checker at a stub so response parsing can be tested.
func newCheckerWithURL(baseURL string) *HIBPChecker {
	return &HIBPChecker{client: &http.Client{Timeout: hibpTimeout}, baseURL: baseURL}
}

func (c *HIBPChecker) IsBreached(ctx context.Context, password string) (bool, error) {
	sum := sha1.Sum([]byte(password)) // #nosec G401 — HIBP's range API is defined over SHA-1.
	digest := strings.ToUpper(hex.EncodeToString(sum[:]))
	prefix, suffix := digest[:5], digest[5:]

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+prefix, nil)
	if err != nil {
		return false, fmt.Errorf("build breach request: %w", err)
	}
	req.Header.Set("Add-Padding", "true")
	req.Header.Set("User-Agent", "mqvi")

	resp, err := c.client.Do(req)
	if err != nil {
		return false, fmt.Errorf("breach lookup unreachable: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("breach lookup returned %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		candidate, count, ok := strings.Cut(scanner.Text(), ":")
		if !ok || !strings.EqualFold(candidate, suffix) {
			continue
		}
		// Padded rows are real hashes with a count of 0 — they exist to fix the response size
		// and must not read as a hit.
		return strings.TrimSpace(count) != "0", nil
	}

	if err := scanner.Err(); err != nil {
		return false, fmt.Errorf("breach lookup read failed: %w", err)
	}
	return false, nil
}

// NoopChecker backs MQVI_PASSWORD_BREACH_CHECK=false — an air-gapped self-host has no route
// to HIBP and should not pay a timeout per signup.
type NoopChecker struct{}

func (NoopChecker) IsBreached(context.Context, string) (bool, error) { return false, nil }
