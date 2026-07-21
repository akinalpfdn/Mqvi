package services

import "testing"

// The extension veto was first written as "must resolve to video/", which refused .webm (Go's table
// maps it to audio/webm) and .mkv (unknown). These cases pin the rule that only a dangerous
// extension may override a video claim.
func TestIsAllowedFeedbackMime(t *testing.T) {
	tests := []struct {
		name     string
		mimeBase string
		filename string
		want     bool
	}{
		{"mp4 video", "video/mp4", "clip.mp4", true},
		{"webm video — Go maps the extension to audio/webm", "video/webm", "clip.webm", true},
		{"mov from a mac", "video/quicktime", "clip.mov", true},
		{"mkv — extension unknown to Go", "video/x-matroska", "clip.mkv", true},
		{"no extension at all — the claimed type is the client's word alone", "video/mp4", "recording", false},
		{"executable claiming to be video", "video/mp4", "payload.exe", false},
		{"unknown container claiming to be video", "video/mp4", "clip.xyz", false},
		{"avi video", "video/x-msvideo", "clip.avi", true},
		{"html claiming to be video", "video/mp4", "payload.html", false},
		{"svg claiming to be video", "video/mp4", "payload.svg", false},
		{"javascript claiming to be video", "video/mp4", "payload.js", false},
		{"allowed image", "image/png", "shot.png", true},
		{"executable claiming to be an image", "image/png", "payload.exe", false},
		{"image with no extension", "image/jpeg", "screenshot", false},
		{"image type on a mismatched extension", "image/png", "shot.pdf", false},
		{"jpeg on .jpg", "image/jpeg", "shot.jpg", true},
		{"plain html rejected outright", "text/html", "page.html", false},
		{"pdf is not an accepted feedback type", "application/pdf", "doc.pdf", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isAllowedFeedbackMime(tc.mimeBase, tc.filename); got != tc.want {
				t.Errorf("isAllowedFeedbackMime(%q, %q) = %v, want %v", tc.mimeBase, tc.filename, got, tc.want)
			}
		})
	}
}
