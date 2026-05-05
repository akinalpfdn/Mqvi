package files

import "testing"

func TestServeDisposition_InlineImage(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc123_photo.jpg", "abc123def45678ab_photo.jpg")
	if ct != "image/jpeg" {
		t.Fatalf("expected image/jpeg, got %s", ct)
	}
	if disp != "" {
		t.Fatalf("expected no disposition for inline image, got %s", disp)
	}
}

func TestServeDisposition_InlineVideo(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc_video.mp4", "abc_video.mp4")
	if ct != "video/mp4" {
		t.Fatalf("expected video/mp4, got %s", ct)
	}
	if disp != "" {
		t.Fatalf("expected no disposition for inline video, got %s", disp)
	}
}

func TestServeDisposition_InlineAudio(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc_song.ogg", "abc_song.ogg")
	if ct != "audio/ogg" {
		t.Fatalf("expected audio/ogg, got %s", ct)
	}
	if disp != "" {
		t.Fatalf("expected no disposition for inline audio, got %s", disp)
	}
}

func TestServeDisposition_ForcedDownload_HTML(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc_payload.html", "a1b2c3d4e5f6g7h8_payload.html")
	if ct != "application/octet-stream" {
		t.Fatalf("expected application/octet-stream for HTML, got %s", ct)
	}
	if disp == "" {
		t.Fatal("expected attachment disposition for HTML")
	}
}

func TestServeDisposition_ForcedDownload_SVG(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc_icon.svg", "a1b2c3d4e5f6g7h8_icon.svg")
	if ct != "application/octet-stream" {
		t.Fatalf("expected application/octet-stream for SVG, got %s", ct)
	}
	if disp == "" {
		t.Fatal("expected attachment disposition for SVG")
	}
}

func TestServeDisposition_ForcedDownload_JS(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc_app.js", "a1b2c3d4e5f6g7h8_app.js")
	if ct != "application/octet-stream" {
		t.Fatalf("expected application/octet-stream for JS, got %s", ct)
	}
	if disp == "" {
		t.Fatal("expected attachment disposition for JS")
	}
}

func TestServeDisposition_ForcedDownload_ZIP(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc_data.zip", "a1b2c3d4e5f6g7h8_data.zip")
	if ct != "application/octet-stream" {
		t.Fatalf("expected application/octet-stream for ZIP, got %s", ct)
	}
	if disp == "" {
		t.Fatal("expected attachment disposition for ZIP")
	}
}

func TestServeDisposition_InlinePDF(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc_doc.pdf", "a1b2c3d4e5f6g7h8_doc.pdf")
	if ct != "application/pdf" {
		t.Fatalf("expected application/pdf, got %s", ct)
	}
	if disp != "" {
		t.Fatalf("expected no disposition for inline PDF, got %s", disp)
	}
}

func TestServeDisposition_UnknownExtension(t *testing.T) {
	ct, disp := ServeDisposition("/data/uploads/messages/m1/abc_thing.xyz", "a1b2c3d4e5f6g7h8_thing.xyz")
	if ct != "application/octet-stream" {
		t.Fatalf("expected application/octet-stream for unknown type, got %s", ct)
	}
	if disp == "" {
		t.Fatal("expected attachment disposition for unknown type")
	}
}

func TestExtractDisplayName_WithHexPrefix(t *testing.T) {
	got := extractDisplayName("a1b2c3d4e5f6g7h8_report.pdf")
	if got != "report.pdf" {
		t.Fatalf("expected 'report.pdf', got '%s'", got)
	}
}

func TestExtractDisplayName_NoPrefix(t *testing.T) {
	got := extractDisplayName("short_file.txt")
	// No 16-char hex prefix, return as-is
	if got != "short_file.txt" {
		t.Fatalf("expected 'short_file.txt', got '%s'", got)
	}
}

func TestExtractDisplayName_PercentEncoded(t *testing.T) {
	got := extractDisplayName("a1b2c3d4e5f6g7h8_%D1%84%D0%B0%D0%B9%D0%BB.pdf")
	if got != "файл.pdf" {
		t.Fatalf("expected 'файл.pdf', got '%s'", got)
	}
}

func TestFormatAttachmentDisposition_ASCII(t *testing.T) {
	got := formatAttachmentDisposition("report.pdf")
	expected := `attachment; filename="report.pdf"`
	if got != expected {
		t.Fatalf("expected %q, got %q", expected, got)
	}
}

func TestFormatAttachmentDisposition_NonASCII(t *testing.T) {
	got := formatAttachmentDisposition("файл.pdf")
	// Should contain both filename= (ASCII fallback) and filename*=UTF-8''
	if got == "" {
		t.Fatal("expected non-empty disposition")
	}
	if !contains(got, "filename*=UTF-8''") {
		t.Fatalf("expected UTF-8 filename*, got %q", got)
	}
	if !contains(got, `filename="`) {
		t.Fatalf("expected ASCII fallback filename, got %q", got)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
