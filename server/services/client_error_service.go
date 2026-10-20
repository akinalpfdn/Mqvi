package services

import (
	"crypto/sha256"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
)

// ClientErrorReport is one unhandled error a client caught. Nothing in it identifies the user,
// and Record scrubs what could: tokens, email addresses, URL query strings, ids in the route.
type ClientErrorReport struct {
	Kind       string `json:"kind"`
	Message    string `json:"message"`
	Stack      string `json:"stack"`
	Route      string `json:"route"`
	Platform   string `json:"platform"`
	AppVersion string `json:"app_version"`
}

// MaxClientErrorsPerBatch bounds one request; the rest of an oversized batch is dropped.
const MaxClientErrorsPerBatch = 5

const (
	maxClientErrorMessage = 500
	maxClientErrorStack   = 2000
	maxClientErrorRoute   = 200

	// The route is public, so the per-IP limit alone does not bound what is stored: every report
	// is a 30-day app_logs row and shares the log writer's queue with every other category.
	// These cap the total across all clients; past them, reports are dropped (and logged once).
	// The per-day cap is what bounds the table: at most 30 days of it are ever kept.
	ClientErrorsPerMinute = 20
	ClientErrorsPerDay    = 1000
	// Render crashes have their own minute budget: they are the reports that matter most, and a
	// flood of ordinary ones must not crowd them out. The day cap is shared.
	RenderCrashesPerMinute = 10
	// The same error (message, first stack line, platform, version) is stored once per window.
	clientErrorDedupeWindow = time.Hour
	// Bounds the dedupe memory; reaching it starts the window over.
	maxClientErrorKeys = 10000
)

var (
	clientErrorKinds     = map[string]bool{"error": true, "unhandledrejection": true, "render": true}
	clientErrorPlatforms = map[string]bool{"web": true, "electron": true, "ios": true, "android": true}

	jwtPattern      = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}`)
	bearerPattern   = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/-]+=*`)
	emailPattern    = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	urlQueryPattern = regexp.MustCompile(`(https?://[^\s?#"'<>]+)\?[^\s#"'<>]*`)
	// Ids written into messages ("No session found for <user>:<device>"): uuids, and the 16-hex
	// ids the database generates (lower(hex(randomblob(8)))) or longer hex runs.
	uuidPattern      = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	hexIDPattern     = regexp.MustCompile(`(?i)\b[0-9a-f]{16,}\b`)
	appVersionFormat = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,32}$`)
	// A route segment that is an id: long alphanumerics (uuids, snowflakes) or a number.
	routeIDSegment = regexp.MustCompile(`^([A-Za-z0-9_-]{16,}|[0-9]{4,})$`)
)

// ClientErrorLogger is the part of AppLogService the recorder writes through.
type ClientErrorLogger interface {
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

// ClientErrorService stores client error reports as app logs (category "client"), which the
// platform admin panel lists and the log service purges after 30 days. Repeats are dropped and
// the total is capped per minute and per day, bounding the table at 30 × ClientErrorsPerDay rows.
type ClientErrorService struct {
	logger ClientErrorLogger
	now    func() time.Time

	mu           sync.Mutex
	seen         map[[sha256.Size]byte]time.Time
	minute       window
	renderMinute window
	day          window
}

// window counts admissions in a fixed period and remembers whether its cap was reported.
type window struct {
	start    time.Time
	count    int
	reported bool
}

// take admits one more if the window (restarted after `length`) is under `limit`. The first refusal
// in a window returns refusedFirst, so the drop can be logged once rather than per report.
func (w *window) take(now time.Time, length time.Duration, limit int) (ok, refusedFirst bool) {
	if now.Sub(w.start) >= length {
		*w = window{start: now}
	}
	if w.count >= limit {
		first := !w.reported
		w.reported = true
		return false, first
	}
	w.count++
	return true, false
}

func NewClientErrorService(logger ClientErrorLogger) *ClientErrorService {
	return newClientErrorService(logger, time.Now)
}

func newClientErrorService(logger ClientErrorLogger, now func() time.Time) *ClientErrorService {
	return &ClientErrorService{logger: logger, now: now, seen: make(map[[sha256.Size]byte]time.Time)}
}

// Record scrubs and stores each report; empty, repeated and over-cap reports are skipped.
func (s *ClientErrorService) Record(reports []ClientErrorReport) {
	if len(reports) > MaxClientErrorsPerBatch {
		reports = reports[:MaxClientErrorsPerBatch]
	}
	for _, report := range reports {
		r := sanitizeClientError(report)
		if r.Message == "" || !s.admit(r) {
			continue
		}
		s.logger.Log(models.LogLevelError, models.LogCategoryClient, nil, nil, "client error: "+r.Message, map[string]string{
			"kind":        r.Kind,
			"stack":       r.Stack,
			"route":       r.Route,
			"platform":    r.Platform,
			"app_version": r.AppVersion,
		})
	}
}

// admit decides, in one critical section, whether a report is new and fits this minute's budget.
func (s *ClientErrorService) admit(r ClientErrorReport) bool {
	now := s.now()
	// The first frame, not the whole stack: the same bug reached by different paths is one bug.
	firstFrame := ""
	if lines := strings.SplitN(r.Stack, "\n", 3); len(lines) > 1 {
		firstFrame = lines[1]
	}
	// Hashed: the raw text can run to kilobytes, and the map holds up to maxClientErrorKeys of them.
	key := sha256.Sum256([]byte(r.Platform + "\x00" + r.AppVersion + "\x00" + r.Message + "\x00" + firstFrame))

	s.mu.Lock()
	defer s.mu.Unlock()

	if at, ok := s.seen[key]; ok && now.Sub(at) < clientErrorDedupeWindow {
		return false
	}
	// The day is checked first so a refused report does not spend the minute's budget.
	if ok, first := s.day.take(now, 24*time.Hour, ClientErrorsPerDay); !ok {
		if first {
			log.Printf("[client_errors] daily cap of %d reached; dropping reports until the window resets", ClientErrorsPerDay)
		}
		return false
	}
	minute, limit := &s.minute, ClientErrorsPerMinute
	if r.Kind == "render" {
		minute, limit = &s.renderMinute, RenderCrashesPerMinute
	}
	if ok, first := minute.take(now, time.Minute, limit); !ok {
		s.day.count-- // not stored after all
		if first {
			log.Printf("[client_errors] per-minute cap of %d %s reports reached; dropping them", limit, r.Kind)
		}
		return false
	}

	if len(s.seen) >= maxClientErrorKeys {
		for k, at := range s.seen {
			if now.Sub(at) >= clientErrorDedupeWindow {
				delete(s.seen, k)
			}
		}
		if len(s.seen) >= maxClientErrorKeys {
			s.seen = make(map[[sha256.Size]byte]time.Time)
		}
	}
	s.seen[key] = now
	return true
}

func sanitizeClientError(r ClientErrorReport) ClientErrorReport {
	kind := r.Kind
	if !clientErrorKinds[kind] {
		kind = "error"
	}
	platform := r.Platform
	if !clientErrorPlatforms[platform] {
		platform = "unknown"
	}
	version := strings.TrimSpace(r.AppVersion)
	if !appVersionFormat.MatchString(version) {
		version = ""
	}
	return ClientErrorReport{
		Kind:       kind,
		Message:    truncateRunes(scrubSecrets(strings.TrimSpace(r.Message)), maxClientErrorMessage),
		Stack:      truncateRunes(scrubSecrets(r.Stack), maxClientErrorStack),
		Route:      truncateRunes(scrubRoute(r.Route), maxClientErrorRoute),
		Platform:   platform,
		AppVersion: version,
	}
}

func scrubSecrets(s string) string {
	s = jwtPattern.ReplaceAllString(s, "[token]")
	s = bearerPattern.ReplaceAllString(s, "Bearer [token]")
	s = emailPattern.ReplaceAllString(s, "[email]")
	s = urlQueryPattern.ReplaceAllString(s, "$1?[query]")
	s = uuidPattern.ReplaceAllString(s, "[id]")
	return hexIDPattern.ReplaceAllString(s, "[id]")
}

// scrubRoute keeps the path's shape (/channels/:id/:id) and drops the query, fragment and ids.
func scrubRoute(route string) string {
	if i := strings.IndexAny(route, "?#"); i >= 0 {
		route = route[:i]
	}
	segments := strings.Split(route, "/")
	for i, seg := range segments {
		if routeIDSegment.MatchString(seg) {
			segments[i] = ":id"
		}
	}
	return strings.Join(segments, "/")
}
