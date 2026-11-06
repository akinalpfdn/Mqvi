// Package services — voice joins whose authorization could not be read yet.
package services

import (
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/ws"
)

// ErrVoiceJoinDeferred is a websocket join that could not be decided because a read failed. It is
// not a refusal: the join is tried again in the background (deferJoin).
var ErrVoiceJoinDeferred = errors.New("voice join deferred: authorization could not be read")

// defaultJoinRetryDelays space the background tries of a deferred join: about 30 s in all. The
// typical cause is a restart, when every client re-asserts at once and the database is busiest.
var defaultJoinRetryDelays = []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second}

// voiceJoinRequest is what a websocket voice_join asked for, kept to try it again.
type voiceJoinRequest struct {
	userID      string
	username    string
	displayName string
	avatarURL   string
	channelID   string
	isMuted     bool
	isDeafened  bool
}

// deferredJoin is the background try a user is waiting on; gen tells a stale timer from the
// current one.
type deferredJoin struct {
	gen       uint64
	channelID string
}

// joinDecision is joinAuthorized's answer. joinUnknown means a read failed: nothing was decided.
type joinDecision int

const (
	joinAllowed joinDecision = iota
	joinRefused
	joinUnknown
)

// deferJoin answers a join that could not be decided. The user stays in the LiveKit room they
// connected to and the join is tried again later; a pending marker keeps the channel's room bound
// meanwhile. Only when the last try still cannot decide is the join refused, with a trace in the
// admin log — the client is told the same way a refusal tells it.
//
// MUST NOT be called under s.mu.
func (s *voiceService) deferJoin(req voiceJoinRequest, attempt int, cause error) error {
	if attempt < len(s.joinRetryDelays) {
		s.mu.Lock()
		s.deferredJoinGen++
		gen := s.deferredJoinGen
		s.deferredJoins[req.userID] = deferredJoin{gen: gen, channelID: req.channelID}
		s.mu.Unlock()
		s.markPendingJoin(req.channelID, req.userID, false)

		log.Printf("[voice] join deferred user=%s channel=%s try=%d: %v", req.userID, req.channelID, attempt+1, cause)
		time.AfterFunc(s.joinRetryDelays[attempt], func() { s.retryDeferredJoin(req, attempt+1, gen) })
		return ErrVoiceJoinDeferred
	}

	log.Printf("[voice] join dropped user=%s channel=%s after %d tries: %v", req.userID, req.channelID, attempt+1, cause)
	s.logError(models.LogCategoryVoice, &req.userID, "voice join dropped: authorization could not be read", map[string]string{
		"channel_id": req.channelID, "tries": strconv.Itoa(attempt + 1), "error": cause.Error(),
	})
	s.mu.Lock()
	s.clearPendingJoinLocked(req.channelID, req.userID)
	s.mu.Unlock()
	return fmt.Errorf("%w (%v)", ErrVoiceJoinRefused, cause)
}

// retryDeferredJoin is one background try. It acts only if nothing replaced the deferred join (a
// newer join or a leave cancels it) and the user is still connected.
func (s *voiceService) retryDeferredJoin(req voiceJoinRequest, attempt int, gen uint64) {
	s.mu.Lock()
	current, ok := s.deferredJoins[req.userID]
	mine := ok && current.gen == gen
	if mine {
		delete(s.deferredJoins, req.userID)
	}
	s.mu.Unlock()
	if !mine {
		return
	}
	if !s.userOnline(req.userID) {
		s.mu.Lock()
		s.clearPendingJoinLocked(req.channelID, req.userID)
		s.mu.Unlock()
		return
	}

	serverID, err := s.join(req, attempt)
	if !errors.Is(err, ErrVoiceJoinRefused) {
		return
	}
	// A join answered directly is refused by the hub on that connection. In the background there is
	// no connection to answer, so the user is told — unless a newer join put them in voice since.
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, inVoice := s.states[req.userID]; !inVoice {
		// Without the server (its channel could not be read) the signal has no queue to go through;
		// the client then stays in LiveKit with no voice state, which the reconciliation sweep judges.
		s.emitToUserLocked(serverID, req.userID, ws.Event{Op: ws.OpVoiceForceDisconnect})
	}
}

// cancelDeferredJoinLocked drops a deferred join of userID, and the pending marker it held: a newer
// join or a leave decides instead. MUST be called under s.mu.
func (s *voiceService) cancelDeferredJoinLocked(userID string) {
	if d, ok := s.deferredJoins[userID]; ok {
		delete(s.deferredJoins, userID)
		s.clearPendingJoinLocked(d.channelID, userID)
	}
}

// userOnline reports whether userID has a websocket. Without an online source, assume they do.
func (s *voiceService) userOnline(userID string) bool {
	if s.onlineChecker == nil {
		return true
	}
	for _, id := range s.onlineChecker.GetOnlineUserIDs() {
		if id == userID {
			return true
		}
	}
	return false
}
