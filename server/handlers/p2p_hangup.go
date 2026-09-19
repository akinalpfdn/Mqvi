package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ratelimit"
)

// CallKeyEnder ends a call for the side holding the key. ISP over P2PCallService.
type CallKeyEnder interface {
	EndCallWithKey(callID, key string) error
}

// P2PHangupHandler serves POST /api/calls/{id}/hangup: the hang-up of an iOS app whose page is
// suspended, sent by its native layer. There is no session; the per-call key is the credential.
type P2PHangupHandler struct {
	calls   CallKeyEnder
	limiter *ratelimit.MessageRateLimiter
}

func NewP2PHangupHandler(calls CallKeyEnder, limiter *ratelimit.MessageRateLimiter) *P2PHangupHandler {
	return &P2PHangupHandler{calls: calls, limiter: limiter}
}

func (h *P2PHangupHandler) Hangup(w http.ResponseWriter, r *http.Request) {
	if h.limiter != nil && !h.limiter.Allow(ratelimit.ExtractIP(r)) {
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Key == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "key is required")
		return
	}
	// The same answer whether the call existed or not: the key is the only thing to learn, and
	// a call already over is the common case (the page hung up first when it woke).
	_ = h.calls.EndCallWithKey(r.PathValue("id"), body.Key) // outcome deliberately not revealed
	w.WriteHeader(http.StatusNoContent)
}
