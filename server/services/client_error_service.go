package services

import (
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
	// ClientErrorsPerMinute caps them across all clients; past it, reports are dropped.
	ClientErrorsPerMinute = 20
	// The same error (message, first stack line, platform, version) is stored once per window.
	clientErrorDedupeWindow = time.Hour
	// Bounds the dedupe memory; reaching it starts the window over.
	maxClientErrorKeys = 10000
)

var (
	clientErrorKinds     = map[string]bool{"error": true, "unhandledrejection": true}
	clientErrorPlatforms = map[string]bool{"web": true, "electron": true, "ios": true, "android": true}

	jwtPattern       = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}`)
	bearerPattern    = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/-]+=*`)
	emailPattern     = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	urlQueryPattern  = regexp.MustCompile(`(https?://[^\s?#"'<>]+)\?[^\s#"'<>]*`)
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
// the total is capped per minute, so the public route cannot flood the table or the log queue.
type ClientErrorService struct {
	logger ClientErrorLogger
	now    func() time.Time

	mu          sync.Mutex
	seen        map[string]time.Time
	minuteStart time.Time
	minuteCount int
}

func NewClientErrorService(logger ClientErrorLogger) *ClientErrorService {
	return newClientErrorService(logger, time.Now)
}

func newClientErrorService(logger ClientErrorLogger, now func() time.Time) *ClientErrorService {
	return &ClientErrorService{logger: logger, now: now, seen: make(map[string]time.Time)}
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
	key := r.Platform + "|" + r.AppVersion + "|" + r.Message + "|" + firstFrame

	s.mu.Lock()
	defer s.mu.Unlock()

	if at, ok := s.seen[key]; ok && now.Sub(at) < clientErrorDedupeWindow {
		return false
	}
	if now.Sub(s.minuteStart) >= time.Minute {
		s.minuteStart, s.minuteCount = now, 0
	}
	if s.minuteCount >= ClientErrorsPerMinute {
		return false
	}
	s.minuteCount++

	if len(s.seen) >= maxClientErrorKeys {
		for k, at := range s.seen {
			if now.Sub(at) >= clientErrorDedupeWindow {
				delete(s.seen, k)
			}
		}
		if len(s.seen) >= maxClientErrorKeys {
			s.seen = make(map[string]time.Time)
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
	return urlQueryPattern.ReplaceAllString(s, "$1?[query]")
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
