package config

import (
	"testing"
	"time"
)

// A kill switch that silently keeps its default when you typo the value is worse than one that
// refuses to boot. It is 3am, push is storming, you set the delay to 0 to disable the wait — and
// a silent fallback leaves the 3s default running while telling you nothing. You would be
// debugging a switch you believe you already flipped.
func TestGetEnvDuration_RefusesAValueItCannotParse(t *testing.T) {
	t.Setenv("MQVI_TEST_DURATION", "0x")

	if _, err := getEnvDuration("MQVI_TEST_DURATION", 3*time.Second); err == nil {
		t.Fatal("a mistyped duration silently fell back to the default — the operator would think the knob was set")
	}
}

func TestGetEnvDuration_AcceptsZeroBecauseZeroDisablesTheWait(t *testing.T) {
	t.Setenv("MQVI_TEST_DURATION", "0")

	got, err := getEnvDuration("MQVI_TEST_DURATION", 3*time.Second)
	if err != nil {
		t.Fatalf("0 is the documented way to disable the wait: %v", err)
	}
	if got != 0 {
		t.Errorf("got %s, want 0", got)
	}
}

func TestGetEnvDuration_UsesTheDefaultOnlyWhenUnset(t *testing.T) {
	got, err := getEnvDuration("MQVI_TEST_DURATION_UNSET", 3*time.Second)
	if err != nil || got != 3*time.Second {
		t.Errorf("got %s, %v; want 3s, nil", got, err)
	}
}

func TestGetEnvInt_RefusesAValueItCannotParse(t *testing.T) {
	t.Setenv("MQVI_TEST_INT", "sixteen")

	if _, err := getEnvInt("MQVI_TEST_INT", 16); err == nil {
		t.Fatal("a mistyped int silently fell back to the default")
	}
}

// Zero concurrency would mean no pushes at all — that is a typo, not a configuration.
func TestGetEnvInt_RefusesZero(t *testing.T) {
	t.Setenv("MQVI_TEST_INT", "0")

	if _, err := getEnvInt("MQVI_TEST_INT", 16); err == nil {
		t.Fatal("accepted 0, which would silently disable push entirely")
	}
}
