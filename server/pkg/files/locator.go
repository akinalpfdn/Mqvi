// Package files is the single source of truth for upload filesystem layout
// and URL generation. All upload services and handlers must go through Locator
// rather than constructing paths or URLs directly.
//
// Layout under cfg.Upload.Dir:
//
//	messages/<messageID>/<filename>
//	dm/<dmMessageID>/<filename>
//	avatars/<userID>/<filename>
//	wallpapers/<userID>/<filename>
//	soundboards/<serverID>/<filename>
//	server-icons/<serverID>/<filename>
//	feedback/<ticketID>/<filename>
//	reports/<reportID>/<filename>
//
// URL format (relative, suitable for DB storage):
//
//	/api/files/<kind>/<scopeID>/<filename>
//
// Security model: scope IDs and filenames are treated as untrusted input even
// when callers believe them to be server-generated. The Locator validates that
// each component is a single safe path segment before touching the filesystem
// or constructing a URL — defense in depth against handler bugs that pipe form
// values directly through (e.g. the standalone /api/upload endpoint reads
// message_id from a multipart form).
package files

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Kind enumerates the upload categories. The string value is also the on-disk
// directory name and the URL path segment.
type Kind string

const (
	KindMessage    Kind = "messages"
	KindDM         Kind = "dm"
	KindAvatar     Kind = "avatars"
	KindWallpaper  Kind = "wallpapers"
	KindSoundboard Kind = "soundboards"
	KindServerIcon Kind = "server-icons"
	KindFeedback   Kind = "feedback"
	KindReport     Kind = "reports"
)

// validKinds is used by the serve endpoint to reject unknown path segments.
var validKinds = map[Kind]bool{
	KindMessage:    true,
	KindDM:         true,
	KindAvatar:     true,
	KindWallpaper:  true,
	KindSoundboard: true,
	KindServerIcon: true,
	KindFeedback:   true,
	KindReport:     true,
}

// IsValidKind reports whether s is a recognized upload kind.
func IsValidKind(s string) bool {
	return validKinds[Kind(s)]
}

// URLPathPrefix is the public URL path under which all new files are served.
// Old uploads under /api/uploads/ remain served by the legacy handler until
// PHASE-15 migration removes them.
const URLPathPrefix = "/api/files"

// ErrInvalidSegment is returned when a scopeID or filename fails segment
// validation. Callers should treat this as a 400 Bad Request — never let it
// reach disk or DB.
var ErrInvalidSegment = errors.New("invalid path segment")

// validateSegment rejects empty, ., .., embedded separators, NUL, and any path
// that would alter the directory hierarchy when joined. This is the single
// gate every untrusted scopeID and filename must pass through.
func validateSegment(s string) error {
	if s == "" {
		return fmt.Errorf("%w: empty", ErrInvalidSegment)
	}
	if s == "." || s == ".." {
		return fmt.Errorf("%w: reserved name %q", ErrInvalidSegment, s)
	}
	if strings.ContainsAny(s, `/\` + "\x00") {
		return fmt.Errorf("%w: contains separator or NUL", ErrInvalidSegment)
	}
	// Reject any literal ".." appearing as a substring split by separators it
	// might have evaded above. We also reject leading/trailing whitespace and
	// names whose Clean() result differs from the input — those would let a
	// crafted name like "foo/." land somewhere unexpected even after joining.
	if filepath.Clean(s) != s {
		return fmt.Errorf("%w: not in canonical form", ErrInvalidSegment)
	}
	return nil
}

// Locator builds disk paths and public URLs for stored files.
type Locator struct {
	uploadDir    string // absolute or relative root, e.g. "./data/uploads"
	uploadDirAbs string // resolved absolute root used for containment checks
	publicURL    string // base URL prefix used for absolute URL generation, e.g. "https://mqvi.net". Empty = relative.
}

// NewLocator constructs a Locator. publicURL may be empty (relative URLs).
func NewLocator(uploadDir, publicURL string) *Locator {
	clean := strings.TrimRight(filepath.Clean(uploadDir), `/\`)
	abs, err := filepath.Abs(clean)
	if err != nil {
		// filepath.Abs only fails when os.Getwd fails; fall back to the cleaned
		// path so callers still get a usable Locator.
		abs = clean
	}
	return &Locator{
		uploadDir:    clean,
		uploadDirAbs: abs,
		publicURL:    strings.TrimRight(publicURL, "/"),
	}
}

// UploadDir returns the configured root directory.
func (l *Locator) UploadDir() string {
	return l.uploadDir
}

// PublicURL returns the configured public base URL (may be empty).
func (l *Locator) PublicURL() string {
	return l.publicURL
}

// safeJoin joins components under the upload root and verifies the resolved
// path stays inside it. Belt-and-suspenders against any segment validation
// gap; should never trip in practice if validateSegment is enforced upstream.
func (l *Locator) safeJoin(parts ...string) (string, error) {
	joined := filepath.Join(append([]string{l.uploadDir}, parts...)...)
	abs, err := filepath.Abs(joined)
	if err != nil {
		return "", fmt.Errorf("resolve abs path: %w", err)
	}
	rel, err := filepath.Rel(l.uploadDirAbs, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: resolved path escapes upload root", ErrInvalidSegment)
	}
	return abs, nil
}

// DiskDir returns the directory in which files of the given kind+scope are
// stored. Returns ErrInvalidSegment if scopeID is unsafe.
func (l *Locator) DiskDir(kind Kind, scopeID string) (string, error) {
	if !validKinds[kind] {
		return "", fmt.Errorf("%w: unknown kind %q", ErrInvalidSegment, kind)
	}
	if err := validateSegment(scopeID); err != nil {
		return "", fmt.Errorf("scopeID: %w", err)
	}
	return l.safeJoin(string(kind), scopeID)
}

// DiskPath returns the absolute filesystem path for an individual file.
// Returns ErrInvalidSegment if scopeID or filename is unsafe.
func (l *Locator) DiskPath(kind Kind, scopeID, filename string) (string, error) {
	if !validKinds[kind] {
		return "", fmt.Errorf("%w: unknown kind %q", ErrInvalidSegment, kind)
	}
	if err := validateSegment(scopeID); err != nil {
		return "", fmt.Errorf("scopeID: %w", err)
	}
	if err := validateSegment(filename); err != nil {
		return "", fmt.Errorf("filename: %w", err)
	}
	return l.safeJoin(string(kind), scopeID, filename)
}

// EnsureDir creates the destination directory if missing.
func (l *Locator) EnsureDir(kind Kind, scopeID string) error {
	dir, err := l.DiskDir(kind, scopeID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create upload dir: %w", err)
	}
	return nil
}

// RelativeURL returns the path-only URL for storage in DB columns.
// Format: /api/files/<kind>/<escaped scopeID>/<escaped filename>
// Returns ErrInvalidSegment for unsafe components.
func (l *Locator) RelativeURL(kind Kind, scopeID, filename string) (string, error) {
	if !validKinds[kind] {
		return "", fmt.Errorf("%w: unknown kind %q", ErrInvalidSegment, kind)
	}
	if err := validateSegment(scopeID); err != nil {
		return "", fmt.Errorf("scopeID: %w", err)
	}
	if err := validateSegment(filename); err != nil {
		return "", fmt.Errorf("filename: %w", err)
	}
	return URLPathPrefix + "/" + string(kind) + "/" + url.PathEscape(scopeID) + "/" + url.PathEscape(filename), nil
}

// AbsoluteURL returns the fully qualified URL when publicURL is configured;
// otherwise the relative URL. Used by services that need to hand a complete
// URL to clients (e.g. WS broadcasts to remote endpoints).
func (l *Locator) AbsoluteURL(kind Kind, scopeID, filename string) (string, error) {
	rel, err := l.RelativeURL(kind, scopeID, filename)
	if err != nil {
		return "", err
	}
	return l.publicURL + rel, nil
}

// SaveFile writes the data to the canonical disk location and returns the
// relative URL suitable for DB storage. Validates scopeID and filename before
// touching disk and cleans up the partial file on write error.
func (l *Locator) SaveFile(kind Kind, scopeID, filename string, write func(dst *os.File) error) (string, error) {
	dest, err := l.DiskPath(kind, scopeID, filename)
	if err != nil {
		return "", err
	}
	if err := l.EnsureDir(kind, scopeID); err != nil {
		return "", err
	}
	f, err := os.Create(dest)
	if err != nil {
		return "", fmt.Errorf("create file: %w", err)
	}
	if err := write(f); err != nil {
		f.Close()
		os.Remove(dest)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(dest)
		return "", fmt.Errorf("close file: %w", err)
	}
	rel, err := l.RelativeURL(kind, scopeID, filename)
	if err != nil {
		// Should be unreachable — DiskPath already validated — but if it ever
		// does fire we have a stray file we cannot reference. Remove it.
		os.Remove(dest)
		return "", err
	}
	return rel, nil
}

// ResolveServePath validates a raw URL path (the part after URLPathPrefix+"/")
// and returns the absolute disk path to serve. Used by the HTTP serve handler
// so the validation rules live in one place.
//
// The raw path must look like "<kind>/<scopeID>/<filename>" — exactly three
// non-empty segments. URL escapes are decoded before segment validation so
// that "%2e%2e" cannot bypass the .. check.
func (l *Locator) ResolveServePath(rawPath string) (string, error) {
	if rawPath == "" || strings.HasSuffix(rawPath, "/") {
		return "", fmt.Errorf("%w: must reference a file", ErrInvalidSegment)
	}
	parts := strings.Split(rawPath, "/")
	if len(parts) != 3 {
		return "", fmt.Errorf("%w: expected <kind>/<scope>/<file>", ErrInvalidSegment)
	}
	kindStr, err := url.PathUnescape(parts[0])
	if err != nil {
		return "", fmt.Errorf("%w: kind unescape: %v", ErrInvalidSegment, err)
	}
	scopeID, err := url.PathUnescape(parts[1])
	if err != nil {
		return "", fmt.Errorf("%w: scope unescape: %v", ErrInvalidSegment, err)
	}
	filename, err := url.PathUnescape(parts[2])
	if err != nil {
		return "", fmt.Errorf("%w: filename unescape: %v", ErrInvalidSegment, err)
	}
	if !validKinds[Kind(kindStr)] {
		return "", fmt.Errorf("%w: unknown kind %q", ErrInvalidSegment, kindStr)
	}
	if err := validateSegment(scopeID); err != nil {
		return "", fmt.Errorf("scopeID: %w", err)
	}
	if err := validateSegment(filename); err != nil {
		return "", fmt.Errorf("filename: %w", err)
	}
	return l.safeJoin(kindStr, scopeID, filename)
}

// DeleteFromURL removes a file referenced by its stored URL. Supports both the
// new /api/files/... layout and the legacy /api/uploads/... layout so existing
// data keeps working until PHASE-15 migration completes. Missing files are
// ignored (idempotent). Any decoded segment that fails validation is rejected
// — including the photo..png case that the old substring check let through to
// SaveFile but blocked from serve/delete, leaving orphans.
func (l *Locator) DeleteFromURL(storedURL string) {
	switch {
	case storedURL == "":
		return
	case strings.HasPrefix(storedURL, URLPathPrefix+"/"):
		raw := strings.TrimPrefix(storedURL, URLPathPrefix+"/")
		disk, err := l.ResolveServePath(raw)
		if err != nil {
			return
		}
		os.Remove(disk)
	case strings.HasPrefix(storedURL, "/api/uploads/"):
		raw := strings.TrimPrefix(storedURL, "/api/uploads/")
		// Legacy layout permits one optional subdirectory (e.g. "soundboard/")
		// because that is what the pre-PHASE-10 code actually wrote.
		// No url.PathUnescape here: old code stored literal filenames in DB,
		// so a value like "abc%2fname.png" is a literal filename on disk, not
		// a percent-encoded slash. Decoding would turn it into "abc/name.png"
		// and fail validation, leaving an orphan file.
		parts := strings.Split(raw, "/")
		if len(parts) == 0 || len(parts) > 2 {
			return
		}
		for _, p := range parts {
			if err := validateSegment(p); err != nil {
				return
			}
		}
		disk, err := l.safeJoin(parts...)
		if err != nil {
			return
		}
		os.Remove(disk)
	}
}

// SanitizeFilename strips path components and dangerous characters and
// normalizes characters that would otherwise produce ambiguous URLs or evade
// segment validation (path separators, NUL, leading dots, embedded "..", and
// URL-meaningful characters). Returns "unnamed" if nothing usable remains.
//
// The output is guaranteed to satisfy validateSegment.
func SanitizeFilename(name string) string {
	// Normalize backslash to forward slash before extracting basename so
	// "win\path\file.png" yields "file.png" on every platform. path.Base
	// always uses '/' — unlike filepath.Base which is OS-dependent.
	name = strings.ReplaceAll(name, `\`, "/")
	name = path.Base(name)
	name = strings.ReplaceAll(name, "..", "_")
	name = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', '\x00', '?', '#', '%', ':':
			return '_'
		}
		// Reject other control chars
		if r < 0x20 || r == 0x7f {
			return '_'
		}
		return r
	}, name)
	// Trim leading dots / spaces — files like ".bashrc" or " .png" are
	// problematic across platforms and not relevant for user uploads.
	name = strings.TrimLeft(name, ". ")
	if name == "" || name == "." || name == ".." {
		return "unnamed"
	}
	if filepath.Clean(name) != name {
		return "unnamed"
	}
	return name
}

// GenerateDiskFilename returns a collision-resistant on-disk filename of the
// form <random_hex>_<sanitized_original>. The random prefix preserves
// uniqueness within a scope directory in case two files share an original
// name. Output is guaranteed to be a safe single segment.
func GenerateDiskFilename(originalName string) (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("random filename: %w", err)
	}
	return hex.EncodeToString(b) + "_" + SanitizeFilename(originalName), nil
}
