package files

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocator_RelativeURL_HappyPath(t *testing.T) {
	l := NewLocator(t.TempDir(), "")
	got, err := l.RelativeURL(KindMessage, "msg-123", "abc.png")
	if err != nil {
		t.Fatal(err)
	}
	want := "/api/files/messages/msg-123/abc.png"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestLocator_RelativeURL_EscapesUnsafeURLChars(t *testing.T) {
	l := NewLocator(t.TempDir(), "")
	// scopeID with space (allowed by validateSegment) must be percent-encoded
	got, err := l.RelativeURL(KindAvatar, "user 1", "x.png")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(got, "user%201") {
		t.Fatalf("expected URL to escape space, got %q", got)
	}
}

func TestLocator_AbsoluteURL(t *testing.T) {
	tests := []struct {
		name      string
		publicURL string
		want      string
	}{
		{"empty publicURL falls back to relative", "", "/api/files/avatars/u1/x.png"},
		{"trailing slash trimmed", "https://mqvi.net/", "https://mqvi.net/api/files/avatars/u1/x.png"},
		{"plain host", "https://files.mqvi.net", "https://files.mqvi.net/api/files/avatars/u1/x.png"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := NewLocator(t.TempDir(), tt.publicURL)
			got, err := l.AbsoluteURL(KindAvatar, "u1", "x.png")
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

func TestLocator_RejectsTraversalScope(t *testing.T) {
	root := t.TempDir()
	l := NewLocator(root, "")

	cases := []string{
		"..",
		".",
		"",
		"../../etc",
		"foo/bar",
		`win\path`,
		"with\x00null",
		"./dot",
		"trail/",
	}
	for _, scope := range cases {
		t.Run("scope="+scope, func(t *testing.T) {
			if _, err := l.DiskPath(KindMessage, scope, "f.png"); !errors.Is(err, ErrInvalidSegment) {
				t.Fatalf("DiskPath: expected ErrInvalidSegment, got %v", err)
			}
			if _, err := l.RelativeURL(KindMessage, scope, "f.png"); !errors.Is(err, ErrInvalidSegment) {
				t.Fatalf("RelativeURL: expected ErrInvalidSegment, got %v", err)
			}
			if _, err := l.SaveFile(KindMessage, scope, "f.png", func(*os.File) error { return nil }); !errors.Is(err, ErrInvalidSegment) {
				t.Fatalf("SaveFile: expected ErrInvalidSegment, got %v", err)
			}
		})
	}
}

func TestLocator_RejectsTraversalFilename(t *testing.T) {
	root := t.TempDir()
	l := NewLocator(root, "")

	cases := []string{"..", ".", "", "a/b", `a\b`, "with\x00null"}
	for _, fn := range cases {
		if _, err := l.SaveFile(KindMessage, "scope", fn, func(*os.File) error { return nil }); !errors.Is(err, ErrInvalidSegment) {
			t.Fatalf("filename %q: expected ErrInvalidSegment, got %v", fn, err)
		}
	}
}

func TestLocator_SaveFile_DoesNotEscapeRoot(t *testing.T) {
	root := t.TempDir()
	l := NewLocator(root, "")

	// Even if validateSegment somehow passed, safeJoin should refuse anything
	// that resolves outside the upload root. We exercise that path via the
	// public API by feeding scopes/files that the validator catches first —
	// here we just confirm that no file is written in any location at all.
	if _, err := l.SaveFile(KindMessage, "../../etc", "passwd", func(f *os.File) error {
		_, err := f.WriteString("pwned")
		return err
	}); err == nil {
		t.Fatal("expected error, got nil")
	}

	// Make sure nothing appeared above the upload root.
	parent := filepath.Dir(root)
	if entries, err := os.ReadDir(parent); err == nil {
		for _, e := range entries {
			if e.Name() == "etc" || e.Name() == "passwd" {
				t.Fatalf("file appeared outside upload root: %s", e.Name())
			}
		}
	}
}

func TestLocator_ResolveServePath(t *testing.T) {
	root := t.TempDir()
	l := NewLocator(root, "")

	// Set up a file
	dir := filepath.Join(root, "messages", "m1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("happy path", func(t *testing.T) {
		got, err := l.ResolveServePath("messages/m1/a.txt")
		if err != nil {
			t.Fatal(err)
		}
		want, _ := filepath.Abs(filepath.Join(root, "messages", "m1", "a.txt"))
		if got != want {
			t.Fatalf("got %q want %q", got, want)
		}
	})

	t.Run("rejects traversal", func(t *testing.T) {
		bad := []string{
			"messages/../../etc/passwd",
			"messages/m1/../../../tmp/x",
			"messages/m1/",
			"messages//a.txt",
			"messages/m1/a.txt/extra",
			"unknownkind/m1/a.txt",
			"",
			"messages/./a.txt",
		}
		for _, p := range bad {
			if _, err := l.ResolveServePath(p); err == nil {
				t.Errorf("path %q: expected error, got nil", p)
			}
		}
	})

	t.Run("rejects encoded traversal", func(t *testing.T) {
		// URL-encoded ".." must not bypass the segment check.
		if _, err := l.ResolveServePath("messages/%2e%2e/a.txt"); err == nil {
			t.Fatal("expected error for %2e%2e, got nil")
		}
		if _, err := l.ResolveServePath("messages/m1/%2fother"); err == nil {
			t.Fatal("expected error for embedded /, got nil")
		}
	})
}

func TestSanitizeFilename(t *testing.T) {
	cases := map[string]string{
		"normal.png":          "normal.png",
		"../etc/passwd":       "passwd",
		"sub/dir/file.txt":    "file.txt",
		`win\path\file.png`:   "file.png",
		"":                    "unnamed",
		".":                   "unnamed",
		"..":                  "_", // ".." → "_" via ReplaceAll, still a valid segment
		"with\x00null.png":    "with_null.png",
		"unicode-Ä-Ö-Ü.txt":   "unicode-Ä-Ö-Ü.txt",
		"photo..png":          "photo_png",
		"a?b#c.png":           "a_b_c.png",
		"with%2fweird":        "with_2fweird",
		" leading-space.png":  "leading-space.png",
		".bashrc":             "bashrc",
	}
	for in, want := range cases {
		if got := SanitizeFilename(in); got != want {
			t.Errorf("Sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeFilename_AlwaysProducesValidSegment(t *testing.T) {
	// Whatever garbage we feed in, the output must pass validateSegment so
	// it can be safely passed to SaveFile.
	inputs := []string{
		"", ".", "..", "../../etc/passwd", "with\x00", "trail.", "lead.",
		"???", "%2e%2e", "spaces only", "...", "/", `\`, "a/b/c",
	}
	for _, in := range inputs {
		out := SanitizeFilename(in)
		if err := validateSegment(out); err != nil {
			t.Errorf("SanitizeFilename(%q) = %q failed validateSegment: %v", in, out, err)
		}
	}
}

func TestGenerateDiskFilename(t *testing.T) {
	a, err := GenerateDiskFilename("photo.png")
	if err != nil {
		t.Fatal(err)
	}
	b, err := GenerateDiskFilename("photo.png")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatalf("expected unique filenames, got duplicate %q", a)
	}
	if !strings.HasSuffix(a, "_photo.png") {
		t.Fatalf("expected suffix _photo.png, got %q", a)
	}
	// Result must always be a safe single segment.
	if err := validateSegment(a); err != nil {
		t.Fatalf("generated name fails validation: %v", err)
	}
}

func TestSaveFile_RoundTrip(t *testing.T) {
	root := t.TempDir()
	l := NewLocator(root, "")

	rel, err := l.SaveFile(KindMessage, "msg-1", "hello.txt", func(dst *os.File) error {
		_, err := dst.WriteString("hello")
		return err
	})
	if err != nil {
		t.Fatalf("SaveFile: %v", err)
	}
	if rel != "/api/files/messages/msg-1/hello.txt" {
		t.Fatalf("relative URL: %q", rel)
	}

	disk := filepath.Join(root, "messages", "msg-1", "hello.txt")
	data, err := os.ReadFile(disk)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "hello" {
		t.Fatalf("content: %q", string(data))
	}
}

func TestDeleteFromURL_BothLayouts(t *testing.T) {
	root := t.TempDir()
	l := NewLocator(root, "")

	newPath := filepath.Join(root, "messages", "m1", "a.txt")
	if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	legacyPath := filepath.Join(root, "deadbeef_legacy.bin")
	if err := os.WriteFile(legacyPath, []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}

	legacySubPath := filepath.Join(root, "soundboard", "abc.wav")
	if err := os.MkdirAll(filepath.Dir(legacySubPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacySubPath, []byte("z"), 0o644); err != nil {
		t.Fatal(err)
	}

	l.DeleteFromURL("/api/files/messages/m1/a.txt")
	if _, err := os.Stat(newPath); !os.IsNotExist(err) {
		t.Fatalf("expected new-layout file removed, stat err=%v", err)
	}

	l.DeleteFromURL("/api/uploads/deadbeef_legacy.bin")
	if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
		t.Fatalf("expected legacy file removed, stat err=%v", err)
	}

	l.DeleteFromURL("/api/uploads/soundboard/abc.wav")
	if _, err := os.Stat(legacySubPath); !os.IsNotExist(err) {
		t.Fatalf("expected legacy soundboard file removed, stat err=%v", err)
	}

	// Path traversal attempts must be ignored, not crash, not delete anything.
	for _, evil := range []string{
		"/api/files/messages/../../etc/passwd",
		"/api/files/messages/m1/../../passwd",
		`/api/uploads/..\..\windows`,
		"/api/uploads/%2e%2e/etc",
		"/api/files/messages/m1/", // directory
		"/api/uploads/a/b/c/d",    // too many segments
	} {
		l.DeleteFromURL(evil) // must not panic
	}
}

func TestIsValidKind(t *testing.T) {
	for _, k := range []string{"messages", "dm", "avatars", "wallpapers", "soundboards", "server-icons", "feedback", "reports"} {
		if !IsValidKind(k) {
			t.Errorf("IsValidKind(%q) = false", k)
		}
	}
	for _, k := range []string{"", "unknown", "../etc", "MESSAGES"} {
		if IsValidKind(k) {
			t.Errorf("IsValidKind(%q) = true, expected false", k)
		}
	}
}
