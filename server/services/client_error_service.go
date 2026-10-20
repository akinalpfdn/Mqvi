package services

import (
	"regexp"
	"strings"

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
	maxClientErrorStack   = 4000
	maxClientErrorRoute   = 200
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
// platform admin panel lists and the log service purges after 30 days.
type ClientErrorService struct {
	logger ClientErrorLogger
}

func NewClientErrorService(logger ClientErrorLogger) *ClientErrorService {
	return &ClientErrorService{logger: logger}
}

// Record scrubs and stores each report; reports with no message are skipped.
func (s *ClientErrorService) Record(reports []ClientErrorReport) {
	if len(reports) > MaxClientErrorsPerBatch {
		reports = reports[:MaxClientErrorsPerBatch]
	}
	for _, report := range reports {
		r := sanitizeClientError(report)
		if r.Message == "" {
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
