package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/ratelimit"
)

const validMicReport = `{"channel_id":"c1","event":"dead","fault":"upstream_paused","faults":["os_muted","upstream_paused"],
"intent":"live","platform":"electron_mac","processor":"rnnoise","app_version":"2.28.2","duration_ms":8000,
"since_reconnect_ms":4200,"trail":[{"e":"reconnected","ago_ms":12200},{"e":"os_muted","ago_ms":8100}],"detail":""}`

func micRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/servers/s1/voice/mic-health", strings.NewReader(body))
	req.SetPathValue("serverId", "s1")
	return req.WithContext(context.WithValue(req.Context(), ctxkeys.User, &models.User{ID: "u1"}))
}

func postMic(h *VoiceHandler, body string) int {
	rr := httptest.NewRecorder()
	h.MicHealth(rr, micRequest(body))
	return rr.Code
}

func TestMicHealth_AcceptsAWellFormedReport(t *testing.T) {
	svc := &stubVoiceService{}
	h := &VoiceHandler{voiceService: svc}

	if code := postMic(h, validMicReport); code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", code)
	}
	if len(svc.micReports) != 1 {
		t.Fatalf("recorded %d reports, want 1", len(svc.micReports))
	}
	got := svc.micReports[0]
	if got.Fault != "upstream_paused" || got.Platform != "electron_mac" || len(got.Trail) != 2 || got.SinceReconnectMs != 4200 {
		t.Fatalf("report not passed through intact: %+v", got)
	}
}

// Everything in a report lands in the operator's log. Each coded field must come from its closed
// set, or a member could write arbitrary text there and the category could not be grouped by cause.
func TestMicHealth_RefusesAnythingOutsideTheClosedSets(t *testing.T) {
	cases := map[string]string{
		"event":       `"event":"dead"`,
		"fault":       `"fault":"upstream_paused"`,
		"intent":      `"intent":"live"`,
		"platform":    `"platform":"electron_mac"`,
		"processor":   `"processor":"rnnoise"`,
		"faults item": `"faults":["os_muted","upstream_paused"]`,
		"trail event": `{"e":"os_muted","ago_ms":8100}`,
		"app_version": `"app_version":"2.28.2"`,
	}
	bad := map[string]string{
		"event":       `"event":"<script>"`,
		"fault":       `"fault":"anything"`,
		"intent":      `"intent":"maybe"`,
		"platform":    `"platform":"ios"`,
		"processor":   `"processor":"krisp"`,
		"faults item": `"faults":["os_muted","free text"]`,
		"trail event": `{"e":"hello","ago_ms":8100}`,
		"app_version": `"app_version":"2.28.2; DROP"`,
	}
	for name, good := range cases {
		t.Run(name, func(t *testing.T) {
			svc := &stubVoiceService{}
			body := strings.Replace(validMicReport, good, bad[name], 1)
			if body == validMicReport {
				t.Fatalf("test fixture did not change the %s field", name)
			}
			if code := postMic(&VoiceHandler{voiceService: svc}, body); code != http.StatusBadRequest {
				t.Fatalf("status %d for a bad %s, want 400", code, name)
			}
			if len(svc.micReports) != 0 {
				t.Fatal("a refused report was recorded")
			}
		})
	}
}

func TestMicHealth_BoundsTheTrailAndTheNumbers(t *testing.T) {
	trail := strings.Repeat(`{"e":"os_muted","ago_ms":1},`, models.MicTrailMax+1)
	long := strings.Replace(validMicReport, `[{"e":"reconnected","ago_ms":12200},{"e":"os_muted","ago_ms":8100}]`, "["+strings.TrimSuffix(trail, ",")+"]", 1)
	if code := postMic(&VoiceHandler{voiceService: &stubVoiceService{}}, long); code != http.StatusBadRequest {
		t.Fatalf("status %d for a %d-entry trail, want 400", code, models.MicTrailMax+1)
	}

	svc := &stubVoiceService{}
	odd := strings.NewReplacer(`"duration_ms":8000`, `"duration_ms":-5`, `"since_reconnect_ms":4200`, `"since_reconnect_ms":-99`,
		`"ago_ms":12200`, `"ago_ms":99999999999`).Replace(validMicReport)
	if code := postMic(&VoiceHandler{voiceService: svc}, odd); code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", code)
	}
	got := svc.micReports[0]
	if got.DurationMs != 0 || got.SinceReconnectMs != -1 || got.Trail[0].AgoMs != 24*60*60*1000 {
		t.Fatalf("numbers not normalised: duration %d, since_reconnect %d, ago %d", got.DurationMs, got.SinceReconnectMs, got.Trail[0].AgoMs)
	}
}

func TestMicHealth_RateLimited(t *testing.T) {
	svc := &stubVoiceService{}
	h := &VoiceHandler{voiceService: svc, micHealthRL: ratelimit.NewMessageRateLimiter(2, time.Minute, 30*time.Second)}
	for i := range 2 {
		if code := postMic(h, validMicReport); code != http.StatusNoContent {
			t.Fatalf("report %d: status %d", i, code)
		}
	}
	if code := postMic(h, validMicReport); code != http.StatusTooManyRequests {
		t.Fatalf("status %d past the limit, want 429", code)
	}
}
