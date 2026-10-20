package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

// maxClientErrorBody fits a full batch of truncated reports with room for JSON overhead.
const maxClientErrorBody = 32 << 10

// ClientErrorRecorder stores scrubbed client error reports against a user (nil when signed out).
type ClientErrorRecorder interface {
	Record(reports []services.ClientErrorReport, userID *string)
}

// ClientErrorHandler serves POST /api/client-errors behind the optional auth middleware: a signed-in
// client's reports carry its user, and errors on the sign-in screen still get in without one. Being
// public, it is bounded per IP (per minute and per day) and by body size; no IP is stored.
type ClientErrorHandler struct {
	recorder ClientErrorRecorder
	limiter  *ratelimit.MessageRateLimiter
	// A render crash comes alone (the client sends it at once, as the app reloads over it) and has
	// its own per-IP budget, so earlier ordinary reports cannot use up the slot it needs.
	renderLimiter *ratelimit.MessageRateLimiter
	// Every request, per IP per day: without it one address could fill the service's daily cap
	// in about an hour and silence reporting for everyone until it resets.
	dailyLimiter *ratelimit.MessageRateLimiter
}

func NewClientErrorHandler(recorder ClientErrorRecorder, limiter, renderLimiter, dailyLimiter *ratelimit.MessageRateLimiter) *ClientErrorHandler {
	return &ClientErrorHandler{recorder: recorder, limiter: limiter, renderLimiter: renderLimiter, dailyLimiter: dailyLimiter}
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
	ip := ratelimit.ExtractIP(r)
	if limiter != nil && !limiter.Allow(ip) {
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	if h.dailyLimiter != nil && !h.dailyLimiter.Allow(ip) {
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many requests")
		return
	}

	var userID *string
	if user, ok := r.Context().Value(ctxkeys.User).(*models.User); ok && user != nil {
		userID = &user.ID
	}
	h.recorder.Record(body.Errors, userID)
	w.WriteHeader(http.StatusNoContent)
}
