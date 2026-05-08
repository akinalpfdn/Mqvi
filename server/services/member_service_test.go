package services

import (
	"strings"
	"testing"
)

// normalizeOwnAvatarURL is the gate that prevents a profile-update caller from
// pointing avatar_url at an arbitrary file path. Tests cover every branch the
// gate is supposed to enforce: own canonical path, signed-own (strip), foreign
// user, foreign kind, percent-encoded path traversal, empty clears, garbage.

const testUserID = "user-self-id"

func TestNormalizeOwnAvatarURL_AcceptsOwnCanonicalPath(t *testing.T) {
	in := "/api/files/avatars/" + testUserID + "/portrait.png"
	got, err := normalizeOwnAvatarURL(in, testUserID)
	if err != nil {
		t.Fatalf("expected accept, got error: %v", err)
	}
	if got != in {
		t.Fatalf("expected unchanged path, got %q", got)
	}
}

func TestNormalizeOwnAvatarURL_StripsSignatureFromOwnPath(t *testing.T) {
	in := "/api/files/avatars/" + testUserID + "/portrait.png?exp=9999999999&sig=abc"
	want := "/api/files/avatars/" + testUserID + "/portrait.png"
	got, err := normalizeOwnAvatarURL(in, testUserID)
	if err != nil {
		t.Fatalf("expected accept signed-own URL, got error: %v", err)
	}
	if got != want {
		t.Fatalf("expected query stripped to %q, got %q", want, got)
	}
}

func TestNormalizeOwnAvatarURL_EmptyClears(t *testing.T) {
	got, err := normalizeOwnAvatarURL("", testUserID)
	if err != nil {
		t.Fatalf("expected accept empty, got error: %v", err)
	}
	if got != "" {
		t.Fatalf("expected empty pass-through, got %q", got)
	}
}

func TestNormalizeOwnAvatarURL_RejectsOtherUserAvatar(t *testing.T) {
	in := "/api/files/avatars/some-other-user/portrait.png"
	if _, err := normalizeOwnAvatarURL(in, testUserID); err == nil {
		t.Fatal("expected reject of other user's avatar path")
	}
}

func TestNormalizeOwnAvatarURL_RejectsForeignKind(t *testing.T) {
	cases := []string{
		"/api/files/dm/abc/private.png",
		"/api/files/messages/m1/attachment.pdf",
		"/api/files/wallpapers/" + testUserID + "/wp.png",
		"/api/files/server-icons/server-1/icon.png",
	}
	for _, in := range cases {
		if _, err := normalizeOwnAvatarURL(in, testUserID); err == nil {
			t.Errorf("expected reject of foreign-kind URL %q", in)
		}
	}
}

func TestNormalizeOwnAvatarURL_RejectsEscapedSlash(t *testing.T) {
	// Percent-encoded slash: locator's serve handler would also reject.
	// The point: nothing this fragile should ever land in the DB.
	in := "/api/files/avatars/" + testUserID + "/foo%2Fbar.png"
	if _, err := normalizeOwnAvatarURL(in, testUserID); err == nil {
		t.Fatal("expected reject of percent-encoded slash in filename")
	}
}

func TestNormalizeOwnAvatarURL_RejectsDotDot(t *testing.T) {
	cases := []string{
		"/api/files/avatars/" + testUserID + "/..",
		"/api/files/avatars/" + testUserID + "/%2e%2e",
		"/api/files/avatars/" + testUserID + "/.",
		"/api/files/avatars/" + testUserID + "/",
	}
	for _, in := range cases {
		if _, err := normalizeOwnAvatarURL(in, testUserID); err == nil {
			t.Errorf("expected reject of traversal/empty filename %q", in)
		}
	}
}

func TestNormalizeOwnAvatarURL_RejectsAbsoluteForeignURL(t *testing.T) {
	cases := []string{
		"https://evil.example/api/files/avatars/" + testUserID + "/p.png",
		"//attacker.example/x.png",
		"javascript:alert(1)",
		"/etc/passwd",
	}
	for _, in := range cases {
		if _, err := normalizeOwnAvatarURL(in, testUserID); err == nil {
			t.Errorf("expected reject of non-canonical URL %q", in)
		}
	}
}

func TestNormalizeOwnAvatarURL_PreservesEscapedFilenameCharacters(t *testing.T) {
	// Filename containing a space should round-trip as the percent-escaped
	// form the upload handler stores (url.PathEscape).
	in := "/api/files/avatars/" + testUserID + "/foo%20bar.png"
	got, err := normalizeOwnAvatarURL(in, testUserID)
	if err != nil {
		t.Fatalf("expected accept of legal escaped char, got error: %v", err)
	}
	if !strings.HasSuffix(got, "/foo%20bar.png") {
		t.Fatalf("expected escaped space preserved, got %q", got)
	}
}
