package ws

import (
	"context"
	"testing"
)

type voipDevices map[string]bool

func (d voipDevices) HasVoIPToken(_ context.Context, _, deviceID string) bool { return d[deviceID] }

// The flag buys a four-hour away window for the call this socket carries. Taken on trust, any
// client could hold its answered call — and both users' "busy" state — open for hours.
func TestNativeMediaClaim(t *testing.T) {
	devices := voipDevices{"iphone": true}
	cases := []struct {
		name     string
		claimed  bool
		deviceID string
		checker  NativeDeviceChecker
		want     bool
	}{
		{"the iOS app that registered for CallKit", true, "iphone", devices, true},
		{"a browser claiming it", true, "laptop", devices, false},
		{"a claim with no device", true, "", devices, false},
		{"no claim", false, "iphone", devices, false},
		{"nothing to check it against", true, "laptop", nil, true},
	}
	for _, c := range cases {
		if got := nativeMediaClaim(context.Background(), c.claimed, "u1", c.deviceID, c.checker); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
