package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"runtime"
	"time"

	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/ws"
)

// dbWaitCountDegraded is the point at which the connection pool is a bottleneck rather than a
// pool. WaitCount is cumulative since boot, so a nonzero value is normal; growth is not. The
// health endpoint reports the number and the operator watches the delta.
const dbWaitCountDegraded = 10_000

type healthReport struct {
	Status     string              `json:"status"` // ok | degraded
	Service    string              `json:"service"`
	DB         dbHealth            `json:"db"`
	WS         wsHealth            `json:"ws"`
	Push       *services.PushStats `json:"push,omitempty"`
	Goroutines int                 `json:"goroutines"`
}

type dbHealth struct {
	Reachable bool   `json:"reachable"`
	LatencyMS int64  `json:"latency_ms"`
	InUse     int    `json:"in_use"`
	Idle      int    `json:"idle"`
	WaitCount int64  `json:"wait_count"`
	WaitMS    int64  `json:"wait_ms"`
	Error     string `json:"error,omitempty"`
}

type wsHealth struct {
	Connections int `json:"connections"`
	Users       int `json:"users"`
}

// registerLiveness adds the public liveness endpoint. Static and cheap: it is what a supervisor
// or an uptime monitor polls, and it must not touch the database.
func registerLiveness(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "mqvi"})
	})
}

// startReadinessServer serves /health/ready on its own loopback listener.
//
// It does a real database round trip per request against a four-connection pool, and it reports
// goroutine counts, pool statistics and socket counts. On the public mux that is both the DoS the
// read endpoints were just rate-limited against, and an information leak. A RemoteAddr check would
// NOT have fixed it: behind the reverse proxy every request already arrives from 127.0.0.1, so
// the check would pass for the whole internet. Binding the listener is the only honest answer.
//
// Returns a shutdown func. A bind failure is logged and degrades to no readiness endpoint rather
// than taking the server down — the app serves fine without it.
func startReadinessServer(addr string, db *sql.DB, hub *ws.Hub, push services.PushNotifier) func(context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/ready", readinessHandler(db, hub, push))

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Printf("[health] readiness endpoint disabled: cannot listen on %s: %v", addr, err)
		return func(context.Context) error { return nil }
	}
	srv := &http.Server{Handler: mux}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[health] readiness server: %v", err)
		}
	}()
	log.Printf("[health] readiness endpoint on http://%s/health/ready", addr)
	return srv.Shutdown
}

func readinessHandler(db *sql.DB, hub *ws.Hub, push services.PushNotifier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		report := healthReport{Status: "ok", Service: "mqvi", Goroutines: runtime.NumGoroutine()}

		// A real round trip, not a ping: PingContext can be answered from the pool without the
		// writer ever being touched.
		start := time.Now()
		var one int
		err := db.QueryRowContext(ctx, "SELECT 1").Scan(&one)
		report.DB.LatencyMS = time.Since(start).Milliseconds()
		report.DB.Reachable = err == nil
		if err != nil {
			report.DB.Error = err.Error()
			report.Status = "degraded"
		}

		stats := db.Stats()
		report.DB.InUse = stats.InUse
		report.DB.Idle = stats.Idle
		report.DB.WaitCount = stats.WaitCount
		report.DB.WaitMS = stats.WaitDuration.Milliseconds()
		if stats.WaitCount > dbWaitCountDegraded {
			report.Status = "degraded"
		}

		if hub != nil {
			report.WS.Connections, report.WS.Users = hub.Counts()
		}
		// Push being down does NOT make the server unready — notifications degrade, serving does
		// not. The numbers are here so an operator can answer "why did this user get nothing?".
		if p, ok := push.(services.PushStatsProvider); ok {
			s := p.Stats()
			report.Push = &s
		}

		w.Header().Set("Content-Type", "application/json")
		if report.Status != "ok" {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(report)
	}
}
