package files

import (
	"mime"
	"net/url"
	"path"
	"strings"
)

// inlineSafeMIME are types that can be rendered inline without XSS risk.
// Everything else is forced to download (Content-Disposition: attachment).
var inlineSafeMIME = map[string]bool{
	// Images
	"image/jpeg":    true,
	"image/png":     true,
	"image/gif":     true,
	"image/webp":    true,
	"image/avif":    true,
	"image/bmp":     true,
	"image/x-icon":  true,
	"image/tiff":    true,
	"image/heic":    true,
	"image/heif":    true,
	// Video
	"video/mp4":       true,
	"video/webm":      true,
	"video/quicktime": true, // .mov
	"video/x-m4v":     true,
	// Audio
	"audio/mpeg":    true, // .mp3
	"audio/mp4":     true, // .m4a
	"audio/x-m4a":   true,
	"audio/aac":     true,
	"audio/ogg":     true,
	"audio/opus":    true,
	"audio/wav":     true,
	"audio/x-wav":   true,
	"audio/flac":    true,
	"audio/x-flac":  true,
	"audio/webm":    true,
	// Text (safe — no script execution)
	"text/plain":       true,
	"text/markdown":    true,
	"text/csv":         true,
	"application/json": true,
	// Documents
	"application/pdf": true,
}

// alwaysAttachment are types that must NEVER be served inline regardless of extension.
// Executable, script, and markup types that can run code in the browser or OS.
var alwaysAttachment = map[string]bool{
	// Markup/script (XSS vectors)
	"text/html":              true,
	"application/xhtml+xml":  true,
	"text/xml":               true,
	"application/xml":        true,
	"image/svg+xml":          true,
	"application/javascript": true,
	"text/javascript":        true,
	// Executables
	"application/x-msdownload":  true, // .exe, .dll
	"application/x-msdos-program": true, // .com, .bat
	"application/x-sh":         true,
	"application/x-msi":        true,
	"application/x-apple-diskimage": true, // .dmg
	"application/vnd.debian.binary-package": true, // .deb
	"application/x-rpm":        true,
	"application/java-archive":  true, // .jar
	"application/vnd.android.package-archive": true, // .apk
}

// extMIMEFallback covers extensions that Go's mime package might not know about.
var extMIMEFallback = map[string]string{
	".heic": "image/heic",
	".heif": "image/heif",
	".avif": "image/avif",
	".m4a":  "audio/mp4",
	".flac": "audio/flac",
	".opus": "audio/opus",
	".mov":  "video/quicktime",
	".m4v":  "video/x-m4v",
	".md":   "text/markdown",
	".log":  "text/plain",
}

// ServeDisposition determines the Content-Type and Content-Disposition headers
// for a file being served. Returns (contentType, disposition).
//
// diskPath: full path on disk (used to extract extension for MIME detection)
// urlFilename: the filename segment from the URL (may be percent-encoded)
//
// Logic:
//   - Detect MIME from extension
//   - If in inlineSafeMIME → serve inline with detected Content-Type
//   - If in alwaysAttachment or not in whitelist → force download as application/octet-stream
func ServeDisposition(diskPath string, urlFilename string) (contentType string, disposition string) {
	ext := strings.ToLower(path.Ext(diskPath))
	detected := mime.TypeByExtension(ext)
	if detected == "" {
		if fb, ok := extMIMEFallback[ext]; ok {
			detected = fb
		} else {
			detected = "application/octet-stream"
		}
	}
	// Strip parameters (e.g. "; charset=utf-8")
	mimeBase := strings.Split(detected, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)

	// Determine the user-facing filename (strip hex prefix from disk filename)
	displayName := extractDisplayName(urlFilename)

	if alwaysAttachment[mimeBase] {
		return "application/octet-stream", formatAttachmentDisposition(displayName)
	}

	if inlineSafeMIME[mimeBase] {
		return detected, ""
	}

	// Everything else: force download
	return "application/octet-stream", formatAttachmentDisposition(displayName)
}

// extractDisplayName strips the random hex prefix from the disk filename.
// Input: "a1b2c3d4e5f6g7h8_report.pdf" (possibly percent-encoded)
// Output: "report.pdf"
func extractDisplayName(urlFilename string) string {
	// Decode percent-encoding first
	decoded, err := url.PathUnescape(urlFilename)
	if err != nil {
		decoded = urlFilename
	}
	// Disk format: <16hex>_<original>
	if idx := strings.IndexByte(decoded, '_'); idx == 16 {
		return decoded[17:]
	}
	return decoded
}

// formatAttachmentDisposition returns a RFC 6266 compliant Content-Disposition header value.
// Uses filename* with UTF-8 encoding for non-ASCII filenames.
func formatAttachmentDisposition(filename string) string {
	// Sanitize: remove control chars and header injection characters
	filename = sanitizeDispositionFilename(filename)
	if filename == "" {
		filename = "download"
	}

	// Check if filename is pure ASCII
	isASCII := true
	for _, c := range filename {
		if c > 127 {
			isASCII = false
			break
		}
	}

	if isASCII {
		// Simple case: quote the filename
		escaped := strings.ReplaceAll(filename, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `"`, `\"`)
		return `attachment; filename="` + escaped + `"`
	}

	// Non-ASCII: use filename* parameter (RFC 5987)
	encoded := url.PathEscape(filename)
	// PathEscape uses %XX but RFC 5987 wants them uppercase (which PathEscape does)
	// Also include a fallback ASCII filename
	asciiName := sanitizeToASCII(filename)
	return `attachment; filename="` + asciiName + `"; filename*=UTF-8''` + encoded
}

// sanitizeDispositionFilename removes characters dangerous in HTTP headers.
func sanitizeDispositionFilename(s string) string {
	var b strings.Builder
	for _, c := range s {
		if c < 32 || c == '\r' || c == '\n' {
			continue
		}
		b.WriteRune(c)
	}
	return b.String()
}

// sanitizeToASCII replaces non-ASCII chars with underscore for the fallback filename.
func sanitizeToASCII(s string) string {
	var b strings.Builder
	for _, c := range s {
		if c > 127 {
			b.WriteByte('_')
		} else if c == '"' || c == '\\' {
			b.WriteByte('_')
		} else {
			b.WriteRune(c)
		}
	}
	result := b.String()
	if result == "" {
		return "download"
	}
	return result
}
