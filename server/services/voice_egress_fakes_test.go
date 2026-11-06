package services

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

// openAudience lets every listed online member see every channel — the pre-filtering behaviour the
// older voice tests were written against. Implements ServerOnlineLister and VoiceVisibilityResolver.
type openAudience struct{ online []string }

func (a openAudience) GetOnlineUserIDsForServer(string) []string { return a.online }

func (openAudience) FilterUsersWithPermission(_ context.Context, _ string, userIDs []string, _ models.Permission) ([]string, error) {
	return userIDs, nil
}

func (openAudience) BuildVisibilityFilter(context.Context, string, string) (*ChannelVisibilityFilter, error) {
	return &ChannelVisibilityFilter{IsAdmin: true}, nil
}

// viewTable is a server whose channels are visible to the listed users only.
type viewTable struct {
	online  []string
	viewers map[string][]string // channelID → users with ViewChannel
	fail    bool                // every lookup errors
	failN   int                 // the next failN lookups error
	gone    map[string]bool     // deleted channels: their lookups answer not found
	onRead  func()              // runs once, at the start of the next lookup
	mu      sync.Mutex
	calls   int // FilterUsersWithPermission calls
}

var errViewLookup = errors.New("view lookup failed")

func (v *viewTable) GetOnlineUserIDsForServer(string) []string { return v.online }

func (v *viewTable) canView(userID, channelID string) bool {
	for _, uid := range v.viewers[channelID] {
		if uid == userID {
			return true
		}
	}
	return false
}

func (v *viewTable) FilterUsersWithPermission(_ context.Context, channelID string, userIDs []string, _ models.Permission) ([]string, error) {
	v.reading()
	v.mu.Lock()
	v.calls++
	gone := v.gone[channelID]
	v.mu.Unlock()
	if gone {
		return nil, fmt.Errorf("get channel %s: %w", channelID, pkg.ErrNotFound)
	}
	if v.failing() {
		return nil, errViewLookup
	}
	var out []string
	for _, uid := range userIDs {
		if v.canView(uid, channelID) {
			out = append(out, uid)
		}
	}
	return out, nil
}

// failing reports whether this lookup errors, using up one of failN.
func (v *viewTable) failing() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.fail {
		return true
	}
	if v.failN > 0 {
		v.failN--
		return true
	}
	return false
}

// reading runs and clears onRead: whatever it changes lands between the caller's snapshot and the
// answer the caller reads.
func (v *viewTable) reading() {
	v.mu.Lock()
	hook := v.onRead
	v.onRead = nil
	v.mu.Unlock()
	if hook != nil {
		hook()
	}
}

func (v *viewTable) BuildVisibilityFilter(_ context.Context, userID, _ string) (*ChannelVisibilityFilter, error) {
	v.reading()
	if v.failing() {
		return nil, errViewLookup
	}
	f := &ChannelVisibilityFilter{HiddenChannels: map[string]bool{}, GrantedChannels: map[string]bool{}}
	for channelID := range v.viewers {
		if v.canView(userID, channelID) {
			f.GrantedChannels[channelID] = true
		}
	}
	return f, nil
}

// delivery is one event as a user's connection receives it.
type delivery struct {
	to    string
	event ws.Event
}

// deliveryLog records what each user is sent, through either hub fan-out.
type deliveryLog struct {
	mu  sync.Mutex
	all []delivery
}

func (l *deliveryLog) broadcaster() *recordingBroadcaster { return &recordingBroadcaster{log: l} }

func (l *deliveryLog) add(to string, e ws.Event) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.all = append(l.all, delivery{to: to, event: e})
}

// to returns the events userID received, in order.
func (l *deliveryLog) to(userID string) []ws.Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []ws.Event
	for _, d := range l.all {
		if d.to == userID {
			out = append(out, d.event)
		}
	}
	return out
}

func (l *deliveryLog) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.all = nil
}

// recordingBroadcaster is a hub that records per-recipient deliveries.
type recordingBroadcaster struct{ log *deliveryLog }

func (b *recordingBroadcaster) BroadcastToAll(ws.Event)                          {}
func (b *recordingBroadcaster) BroadcastToAllExcept(string, ws.Event)            {}
func (b *recordingBroadcaster) BroadcastToServer(string, ws.Event)               {}
func (b *recordingBroadcaster) BroadcastToServerExcept(string, string, ws.Event) {}
func (b *recordingBroadcaster) BroadcastToUser(userID string, e ws.Event)        { b.log.add(userID, e) }
func (b *recordingBroadcaster) BroadcastToUsers(userIDs []string, e ws.Event) {
	seen := map[string]bool{}
	for _, uid := range userIDs {
		if !seen[uid] {
			seen[uid] = true
			b.log.add(uid, e)
		}
	}
}

// inlineEgress delivers on the caller's goroutine, so a test can assert right after the call.
func inlineEgress(svc VoiceService) *voiceService {
	s := svc.(*voiceService)
	s.egress.run = runVoiceEgressInline
	return s
}
