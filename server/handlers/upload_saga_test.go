package handlers

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"strings"

	"github.com/akinalp/mqvi/services"
	"testing"
)

// The two upload policies differ in exactly one thing — what happens to the files after a failure —
// and getting that wrong is silent both ways. Skipping a file on the strict path ships a message
// whose e2ee keys no longer line up with its attachments; aborting on the best-effort path throws
// away a report over an unreadable thumbnail. The byte counts matter just as much: they are what
// the caller releases back, so an over- or under-count is a permanent quota drift.

type fakeAttachment struct {
	name  string
	bytes int64
}

func fakeSize(a *fakeAttachment) int64 { return a.bytes }

// buildFiles produces real *multipart.FileHeader values, since that is what the helpers open.
func buildFiles(t *testing.T, names ...string) []*multipart.FileHeader {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, name := range names {
		part, err := writer.CreateFormFile("files", name)
		if err != nil {
			t.Fatalf("create part %s: %v", name, err)
		}
		if _, err := part.Write([]byte("contents of " + name)); err != nil {
			t.Fatalf("write part %s: %v", name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	reader := multipart.NewReader(&body, writer.Boundary())
	form, err := reader.ReadForm(1 << 20)
	if err != nil {
		t.Fatalf("read form: %v", err)
	}
	t.Cleanup(func() { form.RemoveAll() })
	return form.File["files"]
}

func TestUploadEachFile_KeepsOrderSoAttachmentsStayIndexAligned(t *testing.T) {
	files := buildFiles(t, "a.png", "b.png", "c.png")

	attachments, uploaded, err := uploadEachFile(
		context.Background(), files, nil,
		func(_ context.Context, _ multipart.File, header *multipart.FileHeader, _ *services.ThumbnailUpload) (*fakeAttachment, error) {
			return &fakeAttachment{name: header.Filename, bytes: 10}, nil
		},
		fakeSize,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got := []string{attachments[0].name, attachments[1].name, attachments[2].name}
	want := []string{"a.png", "b.png", "c.png"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("attachment order %v, want %v — the client pairs e2ee_file_keys[i] with attachments[i]", got, want)
		}
	}
	if uploaded != 30 {
		t.Errorf("uploaded = %d, want 30", uploaded)
	}
}

func TestUploadEachFile_StopsAtTheFirstFailureAndCountsOnlyWhatWasStored(t *testing.T) {
	files := buildFiles(t, "a.png", "b.png", "c.png")
	boom := errors.New("disk full")
	var attempted []string

	attachments, uploaded, err := uploadEachFile(
		context.Background(), files, nil,
		func(_ context.Context, _ multipart.File, header *multipart.FileHeader, _ *services.ThumbnailUpload) (*fakeAttachment, error) {
			attempted = append(attempted, header.Filename)
			if header.Filename == "b.png" {
				return nil, boom
			}
			return &fakeAttachment{name: header.Filename, bytes: 10}, nil
		},
		fakeSize,
	)

	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
	// c.png must never be attempted: the send is already doomed and storing it would charge the
	// user for bytes belonging to a message that is about to be deleted.
	if len(attempted) != 2 {
		t.Errorf("attempted %v, want to stop after b.png", attempted)
	}
	if len(attachments) != 1 || attachments[0].name != "a.png" {
		t.Errorf("attachments = %v, want just a.png", attachments)
	}
	// 10, not 20 — b.png stored nothing, so its reservation has to come back.
	if uploaded != 10 {
		t.Errorf("uploaded = %d, want 10", uploaded)
	}
}

func TestUploadEachFile_ReportsAnUnreadablePartAsABadRequest(t *testing.T) {
	// A header with neither in-memory content nor a backing temp file cannot be opened.
	broken := &multipart.FileHeader{Filename: "gone.png", Size: 10}

	_, _, err := uploadEachFile(
		context.Background(), []*multipart.FileHeader{broken}, nil,
		func(_ context.Context, _ multipart.File, _ *multipart.FileHeader, _ *services.ThumbnailUpload) (*fakeAttachment, error) {
			t.Fatal("store must not run for a part that cannot be opened")
			return nil, nil
		},
		fakeSize,
	)

	if !errors.Is(err, errUnreadableUpload) {
		t.Fatalf("err = %v, want errUnreadableUpload so the caller answers 400", err)
	}
}

func TestUploadBestEffort_SkipsAFailureAndKeepsGoing(t *testing.T) {
	files := buildFiles(t, "a.png", "b.png", "c.png")
	var skipped []string

	attachments, uploaded := uploadBestEffort(
		context.Background(), files,
		func(_ context.Context, _ multipart.File, header *multipart.FileHeader) (*fakeAttachment, error) {
			if header.Filename == "b.png" {
				return nil, errors.New("upload failed")
			}
			return &fakeAttachment{name: header.Filename, bytes: 10}, nil
		},
		fakeSize,
		func(filename string, _ error) { skipped = append(skipped, filename) },
	)

	if len(attachments) != 2 || attachments[0].name != "a.png" || attachments[1].name != "c.png" {
		t.Errorf("attachments = %v, want a.png and c.png", attachments)
	}
	// The skipped file's reservation must come back — counting it would leak quota on every
	// failed evidence upload.
	if uploaded != 20 {
		t.Errorf("uploaded = %d, want 20", uploaded)
	}
	if len(skipped) != 1 || skipped[0] != "b.png" {
		t.Errorf("skipped = %v, want [b.png] — a silent skip is what hid broken uploads before", skipped)
	}
}

// A decoded RFC 2231 filename* carries a newline straight through the multipart parser, and every
// caller writes the filename to a log — so an uploader could forge log entries. The real attack
// part is built here rather than a hand-made header, because the parser's behaviour is the whole
// question.
func TestUploadBestEffort_StripsLineBreaksFromTheClientsFilename(t *testing.T) {
	body := "--B\r\n" +
		"Content-Disposition: form-data; name=\"files\"; filename*=UTF-8''evil%0Aforged-log-line\r\n" +
		"Content-Type: image/png\r\n\r\n" +
		"data\r\n--B--\r\n"
	form, err := multipart.NewReader(strings.NewReader(body), "B").ReadForm(1 << 20)
	if err != nil {
		t.Fatalf("read form: %v", err)
	}
	t.Cleanup(func() { form.RemoveAll() })

	// The parser really does hand the newline through — if this ever stops being true the test
	// below would pass for the wrong reason.
	if raw := form.File["files"][0].Filename; !strings.Contains(raw, "\n") {
		t.Fatalf("fixture no longer carries a newline: %q", raw)
	}

	var got string
	uploadBestEffort(
		context.Background(), form.File["files"],
		func(_ context.Context, _ multipart.File, _ *multipart.FileHeader) (*fakeAttachment, error) {
			return nil, errors.New("upload failed")
		},
		fakeSize,
		func(filename string, _ error) { got = filename },
	)

	// Sanitised at the choke point, not at each log call: a caller that writes %s must still be safe.
	if strings.ContainsAny(got, "\r\n") {
		t.Errorf("onSkip received %q — a log line written from it would be forgeable", got)
	}
	if !strings.Contains(got, "forged-log-line") {
		t.Errorf("onSkip received %q — the name should stay recognisable, only the breaks go", got)
	}
}

func TestRespondUploadFailure_UsesTheUnreadableMessageVerbatim(t *testing.T) {
	// The 400 body is a contract with the client, and the string moved into a sentinel during the
	// dedup. This pins that it did not change.
	if !strings.Contains(errUnreadableUpload.Error(), "failed to read uploaded file") {
		t.Errorf("errUnreadableUpload = %q, want the original wording", errUnreadableUpload.Error())
	}
}
