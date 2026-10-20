package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

// maxClientErrorBody fits a full batch of truncated reports with room for JSON overhead.
const maxClientErrorBody = 32 << 10

// ClientErrorRecorder stores scrubbed client error reports.
type ClientErrorRecorder interface {
	Record(reports []services.ClientErrorReport)
}

// ClientErrorHandler serves POST /api/client-errors. Public on purpose — errors on the sign-in
// screen matter too — so it is bounded per IP and by body size, and stores no user or IP.
type ClientErrorHandler struct {
	recorder ClientErrorRecorder
	limiter  *ratelimit.MessageRateLimiter
	// A render crash comes alone (the client sends it at once, as the app reloads over it) and has
	// its own per-IP budget, so earlier ordinary reports cannot use up the slot it needs.
	renderLimiter *ratelimit.MessageRateLimiter
}

func NewClientErrorHandler(recorder ClientErrorRecorder, limiter, renderLimiter *ratelimit.MessageRateLimiter) *ClientErrorHandler {
	return &ClientErrorHandler{recorder: recorder, limiter: limiter, renderLimiter: renderLimiter}
}

func (h *ClientErrorHandler) Report(w http.ResponseWriter, r *http.Request) {
	// Decoded before the limit check: which budget applies depends on what the batch holds.
	r.Body = http.MaxBytesReader(w, r.Body, maxClientErrorBody)
	var body struct {
		Errors []services.ClientErrorReport `json:"errors"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Errors) == 0 {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "errors are required")
		return
	}

	limiter := h.limiter
	if len(body.Errors) == 1 && body.Errors[0].Kind == "render" {
		limiter = h.renderLimiter
	} else {
		// A render crash only gets its budget alone; inside a batch it counts as ordinary.
		for i := range body.Errors {
			if body.Errors[i].Kind == "render" {
				body.Errors[i].Kind = "error"
			}
		}
	}
	if limiter != nil && !limiter.Allow(ratelimit.ExtractIP(r)) {
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	h.recorder.Record(body.Errors)
	w.WriteHeader(http.StatusNoContent)
}
