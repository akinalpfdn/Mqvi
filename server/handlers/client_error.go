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
}

func NewClientErrorHandler(recorder ClientErrorRecorder, limiter *ratelimit.MessageRateLimiter) *ClientErrorHandler {
	return &ClientErrorHandler{recorder: recorder, limiter: limiter}
}

func (h *ClientErrorHandler) Report(w http.ResponseWriter, r *http.Request) {
	if h.limiter != nil && !h.limiter.Allow(ratelimit.ExtractIP(r)) {
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxClientErrorBody)
	var body struct {
		Errors []services.ClientErrorReport `json:"errors"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Errors) == 0 {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "errors are required")
		return
	}
	h.recorder.Record(body.Errors)
	w.WriteHeader(http.StatusNoContent)
}
