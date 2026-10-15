package ws

import "testing"

// A reloaded iOS page hangs up the call the page before it ran, in that page's name: the server
// lets only the app holding an answered call end it, and the new page is a different app.
func TestEndingInstance(t *testing.T) {
	cases := []struct {
		name string
		data P2PCallEndData
		want string
	}{
		{"an ordinary hang-up speaks for this connection", P2PCallEndData{CallID: "x"}, "this-page"},
		{"a reload names the page it replaced", P2PCallEndData{CallID: "x", InstanceID: "old-page"}, "old-page"},
		{"an oversized name is not trusted", P2PCallEndData{CallID: "x", InstanceID: string(make([]byte, 65))}, "this-page"},
	}
	for _, c := range cases {
		if got := endingInstance("this-page", c.data); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
