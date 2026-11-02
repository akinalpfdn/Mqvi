package services

import (
	"strings"
	"testing"

	"github.com/akinalp/mqvi/models"
)

func micReport(event string) models.MicHealthReport {
	return models.MicHealthReport{
		ChannelID: "c1", Event: event, Fault: "upstream_paused", Faults: []string{"os_muted", "upstream_paused"},
		Intent: "live", Platform: "electron_mac", Processor: "rnnoise", AppVersion: "2.28.2",
		DurationMs: 12345, SinceReconnectMs: -1,
		Trail: []models.MicTrailEntry{{Event: "os_muted", AgoMs: 8100}, {Event: "screen_locked", AgoMs: 9000}, {Event: "upstream_paused", AgoMs: 3000}},
	}
}

// The row must say what happened without opening it: cause and platform in the message, the event
// trail oldest first in one readable field.
func TestRecordMicHealth_DeadRowIsReadableAtAGlance(t *testing.T) {
	cap := &captureLogger{}
	s := &voiceService{appLogger: cap}

	s.RecordMicHealth("u1", micReport("dead"))

	if len(cap.entries) != 1 {
		t.Fatalf("%d rows, want 1", len(cap.entries))
	}
	row := cap.entries[0]
	if row.level != models.LogLevelWarn || row.category != models.LogCategoryMic {
		t.Fatalf("level %s category %s, want warn/mic", row.level, row.category)
	}
	if row.message != "mic dead: upstream_paused (electron_mac, live)" {
		t.Fatalf("message %q", row.message)
	}
	if want := "-9.0s screen_locked · -8.1s os_muted · -3.0s upstream_paused"; row.metadata["trail"] != want {
		t.Fatalf("trail %q, want %q", row.metadata["trail"], want)
	}
	if row.metadata["faults"] != "os_muted → upstream_paused" || row.metadata["since_reconnect_ms"] != "none" || row.metadata["app_version"] != "2.28.2" {
		t.Fatalf("metadata %v", row.metadata)
	}
}

// A recovery is good news and goes in at info; still dead at leave is the bad ending and stays warn.
func TestRecordMicHealth_ClosingRows(t *testing.T) {
	cap := &captureLogger{}
	s := &voiceService{appLogger: cap}

	s.RecordMicHealth("u1", micReport("recovered"))
	s.RecordMicHealth("u1", micReport("left_voice"))

	if cap.entries[0].level != models.LogLevelInfo || !strings.HasPrefix(cap.entries[0].message, "mic recovered after 12.3s: upstream_paused") {
		t.Fatalf("recovered row %+v", cap.entries[0])
	}
	if cap.entries[1].level != models.LogLevelWarn || !strings.HasPrefix(cap.entries[1].message, "mic still dead when the user left voice after 12.3s") {
		t.Fatalf("left_voice row %+v", cap.entries[1])
	}
}
