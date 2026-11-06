package ws

import (
	"encoding/json"
	"testing"
)

func refusalTestClient(h *Hub, userID string) *Client {
	return &Client{
		hub:    h,
		userID: userID,
		send:   make(chan []byte, 4),
		done:   make(chan struct{}),
	}
}

func sentOps(t *testing.T, c *Client) []string {
	t.Helper()
	var ops []string
	for {
		select {
		case raw := <-c.send:
			var e Event
			if err := json.Unmarshal(raw, &e); err != nil {
				t.Fatalf("decode sent event: %v", err)
			}
			ops = append(ops, e.Op)
		default:
			return ops
		}
	}
}

// A refused join leaves the client believing it is in a room the server says it is not in. Only the
// connection that asked is told to drop it: another device of the same user may be in voice
// legitimately, and a user-wide disconnect would end that call too.
func TestVoiceJoinRefused_TellsOnlyTheAskingConnection(t *testing.T) {
	h := &Hub{unregister: make(chan *Client, 2)}
	h.onVoiceJoin = func(_, _, _, _, _ string, _, _ bool) bool { return true }

	asking := refusalTestClient(h, "u1")
	sibling := refusalTestClient(h, "u1")

	asking.handleVoiceJoin(Event{Op: OpVoiceJoin, Data: VoiceJoinData{ChannelID: "staff"}})

	if got := sentOps(t, asking); len(got) != 1 || got[0] != OpVoiceForceDisconnect {
		t.Fatalf("asking connection got %v, want [%s]", got, OpVoiceForceDisconnect)
	}
	if got := sentOps(t, sibling); len(got) != 0 {
		t.Fatalf("the user's other connection got %v — a refusal must not end a call elsewhere", got)
	}
}

func TestVoiceJoinAccepted_SendsNothingBack(t *testing.T) {
	h := &Hub{unregister: make(chan *Client, 2)}
	h.onVoiceJoin = func(_, _, _, _, _ string, _, _ bool) bool { return false }

	c := refusalTestClient(h, "u1")
	c.handleVoiceJoin(Event{Op: OpVoiceJoin, Data: VoiceJoinData{ChannelID: "vc"}})

	if got := sentOps(t, c); len(got) != 0 {
		t.Fatalf("an accepted join sent %v back to the client", got)
	}
}
