package ws

import (
	"encoding/json"
	"testing"
)

// A refused initiate is answered on the connection that dialled; a call that started sends nothing here.
func TestP2PCallInitiate_ReportsARefusalOnTheDiallingConnection(t *testing.T) {
	cases := []struct {
		name   string
		reason string
	}{
		{"refused", P2PCallRefusedNotFriends},
		{"started", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &Hub{unregister: make(chan *Client, 1)}
			h.onP2PCallInitiate = func(_, _, _, _ string, _ P2PCallInitiateData) string { return c.reason }
			cl := &Client{hub: h, userID: "u1", send: make(chan []byte, 1), done: make(chan struct{})}
			defer close(cl.done)

			cl.handleP2PCallInitiate(Event{Op: OpP2PCallInitiate, Data: P2PCallInitiateData{ReceiverID: "r1", CallType: "voice"}})

			select {
			case raw := <-cl.send:
				if c.reason == "" {
					t.Fatalf("a call that started sent %s", raw)
				}
				var got struct {
					Op string           `json:"op"`
					D  P2PCallErrorData `json:"d"`
				}
				if err := json.Unmarshal(raw, &got); err != nil {
					t.Fatalf("unmarshal %s: %v", raw, err)
				}
				if got.Op != OpP2PCallError || got.D.Reason != c.reason || got.D.ReceiverID != "r1" {
					t.Errorf("got %+v", got)
				}
			default:
				if c.reason != "" {
					t.Fatal("no p2p_call_error was sent")
				}
			}
		})
	}
}
