// Package services — voice egress: who is told about a voice state change, and in what order.
//
// A voice channel's participants are only for members who can see the channel. Deciding that needs
// the database, and voice state changes happen under s.mu, which must never wait on it. So every
// voice event is queued under s.mu — fixing its order and the participants it concerns at that
// moment — and a per-server worker resolves the audience outside the lock and delivers it.
package services

import (
	"context"
	"log"
	"runtime/debug"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/ws"
)

// VoiceVisibilityResolver answers who may see a voice channel. Implemented by channelPermService.
type VoiceVisibilityResolver interface {
	FilterUsersWithPermission(ctx context.Context, channelID string, userIDs []string, required models.Permission) ([]string, error)
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)
}

const voiceEgressTimeout = 10 * time.Second

// keyedSerialQueue runs tasks one at a time per key, in submission order, and keys concurrently.
// A key's worker goroutine exists only while it has work: it exits as soon as its queue is empty,
// so nothing outlives the tasks and there is nothing to shut down.
type keyedSerialQueue struct {
	mu sync.Mutex
	// A key is present exactly while its worker runs, so presence is the "worker active" flag.
	pending map[string][]func()
}

func newKeyedSerialQueue() *keyedSerialQueue {
	return &keyedSerialQueue{pending: make(map[string][]func())}
}

func (q *keyedSerialQueue) run(key string, task func()) {
	q.mu.Lock()
	_, active := q.pending[key]
	q.pending[key] = append(q.pending[key], task)
	q.mu.Unlock()
	if !active {
		go q.drain(key)
	}
}

func (q *keyedSerialQueue) drain(key string) {
	for {
		q.mu.Lock()
		batch := q.pending[key]
		if len(batch) == 0 {
			delete(q.pending, key)
			q.mu.Unlock()
			return
		}
		q.pending[key] = []func(){}
		q.mu.Unlock()

		for _, task := range batch {
			runVoiceEgressTask(key, task)
		}
	}
}

// A panicking task must not take the process down or stall the rest of the server's events.
func runVoiceEgressTask(key string, task func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[voice] egress task panicked server=%s: %v\n%s", key, r, debug.Stack())
		}
	}()
	task()
}

// runVoiceEgressInline runs a task on the caller's goroutine. Tests use it for deterministic
// delivery; production uses keyedSerialQueue.
func runVoiceEgressInline(_ string, task func()) { task() }

// voiceSnapshot is one server's voice state at a point in the egress order. Avatars are unsigned.
type voiceSnapshot struct {
	states []models.VoiceState
	timers map[string]int64 // channelID → started at (Unix ms), only for channels in states
}

func (sn voiceSnapshot) channelIDs() []string {
	seen := make(map[string]bool)
	var out []string
	for _, st := range sn.states {
		if !seen[st.ChannelID] {
			seen[st.ChannelID] = true
			out = append(out, st.ChannelID)
		}
	}
	return out
}

func (sn voiceSnapshot) channelOf(userID string) string {
	for _, st := range sn.states {
		if st.UserID == userID {
			return st.ChannelID
		}
	}
	return ""
}

type voiceEgress struct {
	hub        ws.Broadcaster
	online     ServerOnlineLister
	visibility VoiceVisibilityResolver
	signer     FileURLSigner
	run        func(serverID string, task func())
}

func newVoiceEgress(hub ws.Broadcaster, online ServerOnlineLister, visibility VoiceVisibilityResolver, signer FileURLSigner) *voiceEgress {
	return &voiceEgress{
		hub:        hub,
		online:     online,
		visibility: visibility,
		signer:     signer,
		run:        newKeyedSerialQueue().run,
	}
}

// channelEvent delivers event to the server's online members who can see channelID, plus always —
// the channel's participants at the time of the change and its subject, who are told whether or
// not they can see the channel.
func (e *voiceEgress) channelEvent(serverID, channelID string, always []string, event ws.Event) {
	e.run(serverID, func() {
		ctx, cancel := context.WithTimeout(context.Background(), voiceEgressTimeout)
		defer cancel()
		event.ServerID = serverID
		audience := unionUserIDs(e.viewers(ctx, channelID, e.onlineIn(serverID)), always)
		e.hub.BroadcastToUsers(audience, event)
	})
}

// toUser delivers a signal meant for one user (force move, force disconnect, AFK kick) in order
// with the server's voice events.
func (e *voiceEgress) toUser(serverID, userID string, event ws.Event) {
	e.run(serverID, func() {
		e.hub.BroadcastToUser(userID, event)
	})
}

// replaceServer sends each target the server's voice states they may see now, replacing what they
// had. users nil means the server's online members at delivery.
func (e *voiceEgress) replaceServer(serverID string, users []string, snap voiceSnapshot) {
	e.run(serverID, func() {
		ctx, cancel := context.WithTimeout(context.Background(), voiceEgressTimeout)
		defer cancel()
		targets := users
		if targets == nil {
			targets = e.onlineIn(serverID)
		}
		if len(targets) == 0 {
			return
		}

		viewersByChannel := make(map[string]map[string]bool)
		for _, channelID := range snap.channelIDs() {
			viewersByChannel[channelID] = toUserSet(e.viewers(ctx, channelID, targets))
		}
		for _, uid := range targets {
			own := snap.channelOf(uid)
			sees := func(channelID string) bool { return channelID == own || viewersByChannel[channelID][uid] }
			e.hub.BroadcastToUser(uid, ws.Event{
				Op:       ws.OpVoiceServerStatesSync,
				ServerID: serverID,
				Data:     e.serverSyncData(serverID, snap, sees),
			})
		}
	})
}

// replaceIfHidden resyncs a user whose channel membership just changed in a channel they cannot see.
// A participant receives the channel's events without ViewChannel; once they leave, nothing would
// clear what they saw, and on joining they hold none of it.
func (e *voiceEgress) replaceIfHidden(serverID, userID string, channelIDs []string, snap voiceSnapshot) {
	e.run(serverID, func() {
		ctx, cancel := context.WithTimeout(context.Background(), voiceEgressTimeout)
		defer cancel()
		vis := e.userVisibility(ctx, userID, serverID, snap)
		hidden := false
		for _, channelID := range channelIDs {
			if !vis.canView(channelID) {
				hidden = true
				break
			}
		}
		if !hidden {
			return
		}
		e.hub.BroadcastToUser(userID, ws.Event{
			Op:       ws.OpVoiceServerStatesSync,
			ServerID: serverID,
			Data:     e.serverSyncData(serverID, snap, vis.sees),
		})
	})
}

// joinSync tells a new member about the calls already running that they may see. Additive join
// events rather than a replace: they hold nothing for this server yet, and old clients understand it.
func (e *voiceEgress) joinSync(serverID, userID string, snap voiceSnapshot) {
	e.run(serverID, func() {
		ctx, cancel := context.WithTimeout(context.Background(), voiceEgressTimeout)
		defer cancel()
		sees := e.userVisibility(ctx, userID, serverID, snap).sees
		started := make(map[string]bool)
		var timers []ws.Event
		for _, st := range snap.states {
			if !sees(st.ChannelID) {
				continue
			}
			e.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpVoiceStateUpdate, Data: voiceJoinBroadcast(st, e.signer)})
			if t, ok := snap.timers[st.ChannelID]; ok && !started[st.ChannelID] {
				started[st.ChannelID] = true
				timers = append(timers, ws.Event{
					Op:   ws.OpVoiceChannelTimerStart,
					Data: ws.VoiceChannelTimerStartData{ChannelID: st.ChannelID, StartedAt: t},
				})
			}
		}
		for _, ev := range timers {
			e.hub.BroadcastToUser(userID, ev)
		}
	})
}

// userVisibility is what one user may see in a server: their own channel, and every channel the
// sidebar shows them. An error leaves only their own channel — withheld, not leaked.
type userVisibility struct {
	own    string
	filter *ChannelVisibilityFilter
}

// canView is ViewChannel itself, without the own-channel exception.
func (v userVisibility) canView(channelID string) bool {
	return v.filter != nil && v.filter.CanSee(channelID)
}

func (v userVisibility) sees(channelID string) bool {
	return channelID == v.own || v.canView(channelID)
}

func (e *voiceEgress) userVisibility(ctx context.Context, userID, serverID string, snap voiceSnapshot) userVisibility {
	vis := userVisibility{own: snap.channelOf(userID)}
	if e.visibility == nil {
		return vis
	}
	f, err := e.visibility.BuildVisibilityFilter(ctx, userID, serverID)
	if err != nil {
		log.Printf("[voice] egress: visibility for user=%s server=%s: %v (only their own channel)", userID, serverID, err)
		return vis
	}
	vis.filter = f
	return vis
}

func (e *voiceEgress) onlineIn(serverID string) []string {
	if e.online == nil {
		return nil
	}
	return e.online.GetOnlineUserIDsForServer(serverID)
}

// viewers keeps the users who hold ViewChannel in channelID. An error keeps nobody.
func (e *voiceEgress) viewers(ctx context.Context, channelID string, users []string) []string {
	if e.visibility == nil || len(users) == 0 {
		return nil
	}
	out, err := e.visibility.FilterUsersWithPermission(ctx, channelID, users, models.PermViewChannel)
	if err != nil {
		log.Printf("[voice] egress: audience for channel=%s: %v (participants only)", channelID, err)
		return nil
	}
	return out
}

func (e *voiceEgress) serverSyncData(serverID string, snap voiceSnapshot, sees func(string) bool) ws.VoiceServerStatesSyncData {
	data := ws.VoiceServerStatesSyncData{
		ServerID:      serverID,
		States:        make([]ws.VoiceStateItem, 0, len(snap.states)),
		ChannelTimers: make(map[string]int64),
	}
	for _, st := range snap.states {
		if !sees(st.ChannelID) {
			continue
		}
		data.States = append(data.States, voiceStateItem(st, e.signer))
		if t, ok := snap.timers[st.ChannelID]; ok {
			data.ChannelTimers[st.ChannelID] = t
		}
	}
	return data
}

func voiceStateItem(st models.VoiceState, signer FileURLSigner) ws.VoiceStateItem {
	return ws.VoiceStateItem{
		UserID:           st.UserID,
		ChannelID:        st.ChannelID,
		ChannelName:      st.ChannelName,
		ServerID:         st.ServerID,
		Username:         st.Username,
		DisplayName:      st.DisplayName,
		AvatarURL:        signer.SignURL(st.AvatarURL),
		IsMuted:          st.IsMuted,
		IsDeafened:       st.IsDeafened,
		IsStreaming:      st.IsStreaming,
		ShareQuality:     st.ShareQuality,
		IsServerMuted:    st.IsServerMuted,
		IsServerDeafened: st.IsServerDeafened,
	}
}

func voiceJoinBroadcast(st models.VoiceState, signer FileURLSigner) ws.VoiceStateUpdateBroadcast {
	return ws.VoiceStateUpdateBroadcast{
		UserID:           st.UserID,
		ChannelID:        st.ChannelID,
		ChannelName:      st.ChannelName,
		ServerID:         st.ServerID,
		Username:         st.Username,
		DisplayName:      st.DisplayName,
		AvatarURL:        signer.SignURL(st.AvatarURL),
		IsMuted:          st.IsMuted,
		IsDeafened:       st.IsDeafened,
		IsStreaming:      st.IsStreaming,
		ShareQuality:     st.ShareQuality,
		IsServerMuted:    st.IsServerMuted,
		IsServerDeafened: st.IsServerDeafened,
		Action:           "join",
	}
}

func unionUserIDs(a, b []string) []string {
	seen := make(map[string]bool, len(a)+len(b))
	out := make([]string, 0, len(a)+len(b))
	for _, list := range [][]string{a, b} {
		for _, id := range list {
			if id != "" && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	return out
}

func toUserSet(ids []string) map[string]bool {
	set := make(map[string]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}
