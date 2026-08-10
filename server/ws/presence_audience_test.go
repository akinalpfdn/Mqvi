package ws

import (
	"sort"
	"testing"
)

// Presence used to go to every connected client on the platform: with many users online each idle
// flip was an O(all connections) fan-out, and it told people who share nothing with the subject
// when that person is at their desk. These pin who is entitled to it now.

// newHub and join live in hub_test.go.

func sortedAudience(h *Hub, userID string) []string {
	got := h.GetPresenceAudience(userID)
	sort.Strings(got)
	return got
}

func TestGetPresenceAudience_ReachesServerMatesAndSkipsStrangers(t *testing.T) {
	h := newHub()
	join(h, "subject", []string{"s1"}, nil)
	join(h, "servermate", []string{"s1"}, nil)
	join(h, "stranger", []string{"s2"}, nil)

	got := sortedAudience(h, "subject")

	// The subject is included: their own other devices use the event to sync status.
	want := []string{"servermate", "subject"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v, want %v — a user sharing no server must not learn the subject is idle", got, want)
	}
}

func TestGetPresenceAudience_ReachesAFriendWithNoSharedServer(t *testing.T) {
	h := newHub()
	join(h, "subject", []string{"s1"}, []string{"friend"})
	join(h, "friend", []string{"s2"}, []string{"subject"})

	got := sortedAudience(h, "subject")

	// The regression this phase must not cause: scoping to servers alone would silently drop
	// friends and DM partners, who could see presence before.
	if len(got) != 2 || got[0] != "friend" || got[1] != "subject" {
		t.Fatalf("got %v, want [friend subject]", got)
	}
}

func TestGetPresenceAudience_SkipsAnOfflineFriend(t *testing.T) {
	h := newHub()
	join(h, "subject", []string{"s1"}, []string{"absent-friend"})

	got := sortedAudience(h, "subject")

	if len(got) != 1 || got[0] != "subject" {
		t.Fatalf("got %v, want [subject] — an offline friend has nothing to receive", got)
	}
}

func TestGetPresenceAudience_CountsAMultiDeviceRecipientOnce(t *testing.T) {
	h := newHub()
	join(h, "subject", []string{"s1"}, nil)
	join(h, "mate", []string{"s1"}, nil)
	join(h, "mate", []string{"s1"}, nil) // second device

	got := sortedAudience(h, "subject")

	if len(got) != 2 {
		t.Fatalf("got %v, want two distinct users — the audience is by user, not by connection", got)
	}
}

// The trap this phase walked into: OnUserFullyDisconnected fires after removeClient has deleted
// the user, so an audience derived at callback time is empty and nobody learns they went offline.
// removeClient captures it before the delete; this asserts the capture, not the callback.
func TestRemoveClient_AudienceCapturedBeforeTheUserIsGone(t *testing.T) {
	h := newHub()
	subject := join(h, "subject", []string{"s1"}, []string{"friend"})
	join(h, "servermate", []string{"s1"}, nil)
	join(h, "friend", []string{"s2"}, []string{"subject"})

	captured := h.GetPresenceAudience("subject")

	// Simulate what removeClient does to the maps on a last-connection close.
	delete(h.clients["subject"], subject)
	delete(h.clients, "subject")
	delete(h.serverClients["s1"], subject)

	after := h.GetPresenceAudience("subject")
	if len(after) != 1 {
		t.Fatalf("expected the post-removal audience to collapse to the subject, got %v", after)
	}
	// Which is exactly why the captured one has to be used: it still holds the recipients.
	if len(captured) != 3 {
		t.Fatalf("captured audience %v, want subject + servermate + friend", captured)
	}
}

func TestAddPresencePeer_RegistersOnEveryConnectionOfBothUsers(t *testing.T) {
	h := newHub()
	a1 := join(h, "a", []string{"s1"}, nil)
	a2 := join(h, "a", []string{"s1"}, nil) // second device
	b1 := join(h, "b", []string{"s2"}, nil)

	h.AddPresencePeer("a", "b")

	// Every connection, not just the first: skipping the rest once one knows would leave the
	// user's other devices blind to the new friend's presence.
	for i, c := range []*Client{a1, a2} {
		if len(c.presencePeerIDs) != 1 || c.presencePeerIDs[0] != "b" {
			t.Fatalf("a's device %d has %v, want [b]", i, c.presencePeerIDs)
		}
	}
	if len(b1.presencePeerIDs) != 1 || b1.presencePeerIDs[0] != "a" {
		t.Fatalf("b has %v, want [a]", b1.presencePeerIDs)
	}

	// Idempotent — accepting twice, or a reconnect racing the accept, must not duplicate.
	h.AddPresencePeer("a", "b")
	if len(a1.presencePeerIDs) != 1 {
		t.Fatalf("duplicate peer after a second call: %v", a1.presencePeerIDs)
	}
}

// The ready snapshot has the mirror of removeClient's problem: `register` is a channel send picked
// up asynchronously by Run, so the payload is built before addClient has put this connection in
// h.clients. Reading memberships off the map there would return only the subject, and the client
// would paint an empty online list.
func TestGetVisibleAudienceFor_WorksBeforeTheConnectionIsRegistered(t *testing.T) {
	h := newHub()
	join(h, "servermate", []string{"s1"}, nil)
	join(h, "friend", []string{"s2"}, []string{"newcomer"})

	// "newcomer" is mid-handshake: not in h.clients yet, but the handler holds its memberships.
	got := h.GetVisibleAudienceFor("newcomer", []string{"s1"}, []string{"friend"})
	sort.Strings(got)

	want := []string{"friend", "newcomer", "servermate"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestGetVisibleAudienceFor_HidesInvisibleUsers(t *testing.T) {
	h := newHub()
	join(h, "subject", []string{"s1"}, nil)
	join(h, "lurker", []string{"s1"}, nil)
	h.invisibleUsers["lurker"] = true

	got := h.GetVisibleAudienceFor("subject", []string{"s1"}, nil)
	sort.Strings(got)

	// Invisibility is one-directional: the lurker still receives everyone else's presence, which
	// is why GetPresenceAudience does not filter and this does.
	if len(got) != 1 || got[0] != "subject" {
		t.Fatalf("got %v, want [subject]", got)
	}
	if len(h.GetPresenceAudience("subject")) != 2 {
		t.Fatal("the lurker must still be in the send-side audience")
	}
}

// Delivery goes to the audience and nobody else.
//
// Note what this does NOT prove: BroadcastToUsers was changed from walking every connection and
// filtering, to looking each recipient up. Both deliver the same set, so this test passes against
// either — it guards the contract, not the complexity. The complexity change is verified by
// reading the function; a unit test cannot see an iteration count without instrumenting a hot
// path, which is not worth it.
func TestBroadcastToUsers_DeliversOnlyToTheAudience(t *testing.T) {
	h := newHub()

	recipient := join(h, "recipient", nil, nil)

	// A crowd that is not in the audience. If delivery walked h.clients, these would all be
	// visited; with a lookup they are never touched.
	bystanders := make([]*Client, 0, 50)
	for i := 0; i < 50; i++ {
		bystanders = append(bystanders, join(h, "bystander-"+string(rune('a'+i%26))+string(rune('0'+i/26)), nil, nil))
	}

	h.BroadcastToUsers([]string{"recipient"}, Event{Op: OpPresence})

	if len(recipient.send) != 1 {
		t.Fatalf("recipient got %d events, want 1", len(recipient.send))
	}
	for i, c := range bystanders {
		if len(c.send) != 0 {
			t.Fatalf("bystander %d received an event it was not in the audience for", i)
		}
	}
}

// A duplicated id must not send twice. Callers build their lists from maps today, but that is
// their invariant, not this function's.
func TestBroadcastToUsers_DedupesRepeatedRecipients(t *testing.T) {
	h := newHub()
	c := join(h, "u1", nil, nil)

	h.BroadcastToUsers([]string{"u1", "u1", "u1"}, Event{Op: OpPresence})

	if len(c.send) != 1 {
		t.Fatalf("got %d events, want 1", len(c.send))
	}
}

// The counterpart to AddPresencePeer. Without it, unfriending or blocking left the other side
// still receiving presence until one of them reconnected.
func TestRemovePresencePeer_WithdrawsTheEntitlementFromBothSides(t *testing.T) {
	h := newHub()
	a := join(h, "a", nil, []string{"b", "c"})
	b := join(h, "b", nil, []string{"a"})

	h.RemovePresencePeer("a", "b")

	// Only the named pair is dropped — an unrelated friendship survives.
	if len(a.presencePeerIDs) != 1 || a.presencePeerIDs[0] != "c" {
		t.Fatalf("a has %v, want [c]", a.presencePeerIDs)
	}
	if len(b.presencePeerIDs) != 0 {
		t.Fatalf("b has %v, want []", b.presencePeerIDs)
	}

	// And the audience follows: b no longer learns about a.
	got := sortedAudience(h, "a")
	if len(got) != 1 || got[0] != "a" {
		t.Fatalf("audience %v, want [a]", got)
	}
}

// The removal must allocate rather than filter in place. The connect handler keeps a local
// pointing at the same backing array while it builds the ready payload; rewriting that array's
// elements underneath it is an unsynchronised write to memory another goroutine is reading.
func TestRemovePresencePeer_DoesNotRewriteTheCallersBackingArray(t *testing.T) {
	h := newHub()
	original := []string{"b", "c"}
	join(h, "a", nil, original)

	h.RemovePresencePeer("a", "b")

	if original[0] != "b" || original[1] != "c" {
		t.Fatalf("the caller's slice was mutated: %v", original)
	}
}
