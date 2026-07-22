package ws

import (
	"encoding/json"
	"testing"

	"github.com/akinalp/mqvi/models"
)

// ready is sent once, on connect, and nothing re-sends it. Anything dropped from it is missing for
// the whole session — which is how the sidebar spent a release with no verified badge and no
// encryption flag: the payload carried a narrower struct than the client destructured, and the only
// symptom was a badge that never appeared.
//
// These are the exact fields systemEventHandlers.ts reads out of `d`. A rename or an added
// `omitempty` on any of them is silent on both sides; the client just sees undefined.
func TestReadyPayload_CarriesEveryFieldTheClientReads(t *testing.T) {
	raw, err := json.Marshal(Event{Op: OpReady, Data: ReadyData{}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var envelope struct {
		Op string         `json:"op"`
		D  map[string]any `json:"d"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if envelope.Op != "ready" {
		t.Errorf("op = %q, want \"ready\" — the client switches on the literal", envelope.Op)
	}

	for _, key := range []string{
		"session_id",
		"online_user_ids",
		"servers",
		"muted_server_ids",
		"muted_channel_ids",
		"pref_status",
	} {
		if _, present := envelope.D[key]; !present {
			t.Errorf(
				"%q is absent from the ready payload at zero value — the client reads it as undefined "+
					"for the whole session (%s)", key, raw,
			)
		}
	}
}

// The sidebar list travels inside ready as the shared model rather than a parallel struct. It was a
// parallel struct once, and that is exactly what silently narrowed it.
func TestReadyPayload_ServerEntriesCarryTheWholeListItem(t *testing.T) {
	raw, err := json.Marshal(Event{
		Op:   OpReady,
		Data: ReadyData{Servers: []models.ServerListItem{{ID: "s1", Name: "Alpha"}}},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var envelope struct {
		D struct {
			Servers []map[string]any `json:"servers"`
		} `json:"d"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(envelope.D.Servers) != 1 {
		t.Fatalf("expected one server entry, got %d", len(envelope.D.Servers))
	}

	for _, key := range []string{"id", "name", "icon_url", "verified", "e2ee_enabled"} {
		if _, present := envelope.D.Servers[0][key]; !present {
			t.Errorf("sidebar entry in ready is missing %q (%s)", key, raw)
		}
	}
}
