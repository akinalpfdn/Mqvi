// Package services — voice egress: who is told about a voice state change, and in what order.
//
// A voice channel's participants are only for members who can see the channel. Deciding that needs
// the database, and voice state changes happen under s.mu, which must never wait on it. So every
// voice event is queued under s.mu — fixing its order and the participants it concerns at that
// moment — and a per-server worker resolves the audience outside the lock and delivers it.
package services

import (
	"context"
	"errors"
	"log"
	"runtime/debug"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

// VoiceVisibilityResolver answers who may see a voice channel. Implemented by channelPermService.
type VoiceVisibilityResolver interface {
	ChannelAudienceFilter
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)
}

const voiceEgressTimeout = 10 * time.Second

// A failed audience read leaves members holding less than they may see: withheld, not leaked, but
// wrong until something replaces it. Each failure is followed by a fresh resync of those members,
// at most this many times in a row (2 s, 4 s, 8 s), so a database that stays down does not spin.
const (
	egressRetryMax  = 3
	egressRetryBase = 2 * time.Second
)

// keyedSerialQueue runs tasks one at a time per key, in submission order, and keys concurrently.
// A key's worker goroutine exists only while it has work: it exits as soon as its queue is empty,
// so nothing outlives the tasks and there is nothing to shut down.
type keyedSerialQueue struct {
	mu sync.Mutex
	// A key is present exactly while its worker runs, so presence is the "worker active" flag.
	pending map[string][]func()
	// outstanding counts a key's tasks from queued to finished. pending alone misses the batch the
	// worker has taken and is running, which made the backlog read as zero behind a long batch.
	outstanding map[string]int
	// observe, if set, is told each task's wait (queued → started), run time and the backlog it
	// joined: the tasks queued or running ahead of it.
	observe func(wait, run time.Duration, depth int)
}

func newKeyedSerialQueue(observe func(wait, run time.Duration, depth int)) *keyedSerialQueue {
	return &keyedSerialQueue{pending: make(map[string][]func()), outstanding: make(map[string]int), observe: observe}
}

func (q *keyedSerialQueue) run(key string, task func()) {
	queuedAt := time.Now()
	q.mu.Lock()
	_, active := q.pending[key]
	depth := q.outstanding[key]
	q.outstanding[key]++
	q.pending[key] = append(q.pending[key], func() {
		started := time.Now()
		defer func() { // a panicking task is still finished, or the count would only grow
			q.mu.Lock()
			if q.outstanding[key]--; q.outstanding[key] <= 0 {
				delete(q.outstanding, key)
			}
			q.mu.Unlock()
			if q.observe != nil {
				q.observe(started.Sub(queuedAt), time.Since(started), depth)
			}
		}()
		task()
	})
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
	stats      *egressStats

	// retry re-sends users (nil: the server's online members) a fresh view after a failed read. Set
	// by the voice service: the snapshot must be taken under its lock to keep its place in the order.
	retry func(serverID string, users []string, attempt int)
	// after schedules a retry; time.AfterFunc outside tests.
	after func(d time.Duration, f func())

	retryMu sync.Mutex
	retries map[string]*pendingRetry // serverID → the one retry waiting for it

	// queued counts every task ever submitted per server. A reader holding s.mu sees a value that
	// matches its snapshot, so a later different value means something was queued since.
	queuedMu sync.Mutex
	queued   map[string]uint64

	// deleted marks channels being deleted, from just before their row goes (see markDeleted).
	deletedMu sync.Mutex
	deleted   map[string]time.Time // channelID → marked at
}

// deletedChannelTTL bounds how long a mark outlives its delete. It only has to cover the reads that
// started before the delete, which time out after voiceEgressTimeout; channel ids are never reused.
const deletedChannelTTL = time.Minute

// markDeleted hides channelID's call from every audience decided from now on. A channel's overrides
// go with its row, after which a hidden channel reads as visible to the base view: a snapshot taken
// before the delete and judged after it would show the call to members who never could see it.
func (e *voiceEgress) markDeleted(channelID string) {
	e.deletedMu.Lock()
	defer e.deletedMu.Unlock()
	now := time.Now()
	if e.deleted == nil {
		e.deleted = make(map[string]time.Time)
	}
	for id, at := range e.deleted {
		if now.Sub(at) > deletedChannelTTL {
			delete(e.deleted, id)
		}
	}
	e.deleted[channelID] = now
}

func (e *voiceEgress) unmarkDeleted(channelID string) {
	e.deletedMu.Lock()
	defer e.deletedMu.Unlock()
	delete(e.deleted, channelID)
}

func (e *voiceEgress) isDeleted(channelID string) bool {
	e.deletedMu.Lock()
	defer e.deletedMu.Unlock()
	_, ok := e.deleted[channelID]
	return ok
}

// submit queues task in serverID's order. Every egress task goes through here.
func (e *voiceEgress) submit(serverID string, task func()) {
	e.queuedMu.Lock()
	if e.queued == nil {
		e.queued = make(map[string]uint64)
	}
	e.queued[serverID]++
	e.queuedMu.Unlock()
	e.run(serverID, task)
}

// position is how many tasks serverID has had queued so far.
func (e *voiceEgress) position(serverID string) uint64 {
	e.queuedMu.Lock()
	defer e.queuedMu.Unlock()
	return e.queued[serverID]
}

// pendingRetry is a scheduled resync. Failures before it fires join it rather than add another.
type pendingRetry struct {
	all     bool
	users   map[string]bool
	attempt int
}

// newVoiceEgress builds the egress; warn receives the queue's slow-window report for the admin log.
func newVoiceEgress(hub ws.Broadcaster, online ServerOnlineLister, visibility VoiceVisibilityResolver, signer FileURLSigner, warn func(string, map[string]string)) *voiceEgress {
	stats := newEgressStats(func(line string) { log.Print(line) }, warn)
	return &voiceEgress{
		hub:        hub,
		online:     online,
		visibility: visibility,
		signer:     signer,
		run:        newKeyedSerialQueue(stats.task).run,
		stats:      stats,
		after:      func(d time.Duration, f func()) { time.AfterFunc(d, f) },
		retries:    make(map[string]*pendingRetry),
	}
}

// retryLater schedules a fresh view of serverID for users (nil: every online member) after a failed
// audience read. One retry waits per server; failures meanwhile widen it instead of stacking.
func (e *voiceEgress) retryLater(serverID string, users []string, attempt int) {
	if e.retry == nil {
		return
	}
	if attempt >= egressRetryMax {
		log.Printf("[voice] egress: gave up resyncing server=%s after %d failed audience reads in a row", serverID, attempt)
		return
	}
	e.retryMu.Lock()
	defer e.retryMu.Unlock()
	if p, ok := e.retries[serverID]; ok {
		p.all = p.all || users == nil
		for _, uid := range users {
			p.users[uid] = true
		}
		return
	}
	p := &pendingRetry{all: users == nil, users: toUserSet(users), attempt: attempt}
	e.retries[serverID] = p
	e.after(egressRetryBase<<attempt, func() {
		e.retryMu.Lock()
		delete(e.retries, serverID)
		var targets []string
		if !p.all {
			targets = make([]string, 0, len(p.users))
			for uid := range p.users {
				targets = append(targets, uid)
			}
		}
		e.retryMu.Unlock()
		e.retry(serverID, targets, p.attempt+1)
	})
}

// channelEvent delivers event to the server's online members who can see channelID, plus always —
// the channel's participants at the time of the change and its subject, who are told whether or
// not they can see the channel.
func (e *voiceEgress) channelEvent(serverID, channelID string, always []string, event ws.Event) {
	e.submit(serverID, func() {
		ctx, cancel := context.WithTimeout(context.Background(), voiceEgressTimeout)
		defer cancel()
		event.ServerID = serverID
		viewers, ok := e.viewers(ctx, channelID, e.onlineIn(serverID))
		audience := unionUserIDs(viewers, always)
		e.hub.BroadcastToUsers(audience, event)
		e.stats.delivered(len(audience))
		if !ok {
			e.retryLater(serverID, nil, 0)
		}
	})
}

// toUser delivers a signal meant for one user (force move, force disconnect, AFK kick) in order
// with the server's voice events.
func (e *voiceEgress) toUser(serverID, userID string, event ws.Event) {
	e.submit(serverID, func() {
		e.hub.BroadcastToUser(userID, event)
	})
}

// replaceServer sends each target the server's voice states they may see now, replacing what they
// had. users nil means the server's online members at delivery.
func (e *voiceEgress) replaceServer(serverID string, users []string, snap voiceSnapshot) {
	e.replaceServerAttempt(serverID, users, snap, 0)
}

// replaceServerAttempt is replaceServer as the attempt-th resync after failed reads.
func (e *voiceEgress) replaceServerAttempt(serverID string, users []string, snap voiceSnapshot, attempt int) {
	e.submit(serverID, func() {
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
		failed := false
		for _, channelID := range snap.channelIDs() {
			viewers, ok := e.viewers(ctx, channelID, targets)
			failed = failed || !ok
			viewersByChannel[channelID] = toUserSet(viewers)
		}
		for _, uid := range targets {
			own := snap.channelOf(uid)
			sees := func(channelID string) bool {
				return !e.isDeleted(channelID) && (channelID == own || viewersByChannel[channelID][uid])
			}
			e.hub.BroadcastToUser(uid, ws.Event{
				Op:       ws.OpVoiceServerStatesSync,
				ServerID: serverID,
				Data:     e.serverSyncData(serverID, snap, sees),
			})
		}
		if failed {
			e.retryLater(serverID, users, attempt)
		}
	})
}

// replaceIfHidden resyncs a user whose channel membership just changed in a channel they cannot see.
// A participant receives the channel's events without ViewChannel; once they leave, nothing would
// clear what they saw, and on joining they hold none of it.
func (e *voiceEgress) replaceIfHidden(serverID, userID string, channelIDs []string, snap voiceSnapshot) {
	e.submit(serverID, func() {
		ctx, cancel := context.WithTimeout(context.Background(), voiceEgressTimeout)
		defer cancel()
		vis := e.userVisibility(ctx, userID, serverID, snap)
		if vis.failed {
			defer e.retryLater(serverID, []string{userID}, 0)
		}
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
	e.submit(serverID, func() {
		ctx, cancel := context.WithTimeout(context.Background(), voiceEgressTimeout)
		defer cancel()
		vis := e.userVisibility(ctx, userID, serverID, snap)
		if vis.failed {
			defer e.retryLater(serverID, []string{userID}, 0)
		}
		sees := vis.sees
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
	failed bool // the read failed: only their own channel, until a retry
	// deleted is asked when the answer is used, which is after the read: a channel deleted in
	// between is seen by nobody, whatever the read made of its missing overrides.
	deleted func(channelID string) bool
}

// canView is ViewChannel itself, without the own-channel exception.
func (v userVisibility) canView(channelID string) bool {
	return v.filter != nil && v.filter.CanSee(channelID) && !v.gone(channelID)
}

func (v userVisibility) sees(channelID string) bool {
	return !v.gone(channelID) && (channelID == v.own || v.canView(channelID))
}

func (v userVisibility) gone(channelID string) bool {
	return v.deleted != nil && v.deleted(channelID)
}

func (e *voiceEgress) userVisibility(ctx context.Context, userID, serverID string, snap voiceSnapshot) userVisibility {
	vis := userVisibility{own: snap.channelOf(userID), deleted: e.isDeleted}
	if e.visibility == nil {
		return vis
	}
	f, err := e.visibility.BuildVisibilityFilter(ctx, userID, serverID)
	if err != nil {
		log.Printf("[voice] egress: visibility for user=%s server=%s: %v (only their own channel)", userID, serverID, err)
		vis.failed = true
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

// viewers keeps the users who hold ViewChannel in channelID. An error keeps nobody and reports false.
// A deleted channel is seen by nobody, and that is an answer, not a failed read: no retry, and no
// slow window raised for a database that is fine.
func (e *voiceEgress) viewers(ctx context.Context, channelID string, users []string) ([]string, bool) {
	if e.isDeleted(channelID) {
		return nil, true
	}
	if e.visibility == nil || len(users) == 0 {
		return nil, true
	}
	started := time.Now()
	out, err := e.visibility.FilterUsersWithPermission(ctx, channelID, users, models.PermViewChannel)
	if errors.Is(err, pkg.ErrNotFound) {
		e.stats.filter(time.Since(started), false)
		return nil, true
	}
	e.stats.filter(time.Since(started), err != nil)
	if err != nil {
		log.Printf("[voice] egress: audience for channel=%s: %v (participants only)", channelID, err)
		return nil, false
	}
	return out, true
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
