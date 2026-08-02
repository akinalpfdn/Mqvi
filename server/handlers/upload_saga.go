package handlers

import (
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// The strict upload path, shared by channel messages and DMs.
//
// "Strict" as opposed to the best-effort paths (feedback, reports, discovery), which skip a file
// that fails and keep going. Here a single failure fails the whole send, because the client pairs
// e2ee_file_keys[i] with attachments[i]: dropping file 2 of 4 shifts every later attachment onto
// the wrong key and the recipient gets a message they cannot decrypt. Delivering that is worse
// than delivering nothing.
//
// The two paths differ in attachment type, upload service and signer, so those arrive as closures;
// what is shared — and what was duplicated — is the ordering rule that makes compensation correct:
// stop at the first failure, report how many bytes were actually stored, and leave the caller to
// undo the parent row and hand back the rest of the reservation.

// errUnreadableUpload marks the client's multipart part as unreadable. That is a 400, distinct from
// a storage failure, which carries its own status through pkg.Error.
var errUnreadableUpload = errors.New("failed to read uploaded file")

// uploadEachFile stores every file in order and stops at the first failure.
//
// Returns the attachments stored so far and their real byte count — real, because a reservation is
// made from the client's declared sizes and the caller has to release the difference. On failure
// the partial results still come back: those bytes are on disk and already charged.
func uploadEachFile[A any](
	ctx context.Context,
	files []*multipart.FileHeader,
	form *multipart.Form,
	store func(ctx context.Context, file multipart.File, header *multipart.FileHeader, thumb *services.ThumbnailUpload) (*A, error),
	storedBytes func(*A) int64,
) ([]A, int64, error) {
	attachments := make([]A, 0, len(files))
	var uploaded int64

	for i, header := range files {
		file, err := header.Open()
		if err != nil {
			return attachments, uploaded, errUnreadableUpload
		}

		// Paired by index, so a missing preview cannot shift the others.
		thumb := thumbnailFor(form, i)
		attachment, err := store(ctx, file, header, thumb)
		file.Close()
		if thumb != nil {
			thumb.File.Close()
		}
		if err != nil {
			return attachments, uploaded, err
		}

		uploaded += storedBytes(attachment)
		attachments = append(attachments, *attachment)
	}

	return attachments, uploaded, nil
}

// uploadBestEffort stores what it can and skips what it cannot.
//
// The opposite policy to uploadEachFile, and correct for the paths that use it: a feedback ticket,
// an abuse report or a discovery report is worth filing without its evidence, and none of them
// index attachments against anything, so a gap changes nothing. Failures are reported through
// onSkip — silently dropping them is what the callers used to do, and it hid genuinely broken
// uploads.
//
// Returns the attachments and the bytes actually stored, so the caller can hand back the rest of
// its reservation.
//
// The filename handed to onSkip is stripped of line breaks first. It is client-controlled — a
// decoded RFC 2231 `filename*` can carry a newline — and every caller writes it to a log, so
// leaving that to each of them means the first one that forgets hands uploaders a way to forge log
// entries. Doing it here makes the guarantee hold for callers that have not been written yet.
func uploadBestEffort[A any](
	ctx context.Context,
	files []*multipart.FileHeader,
	store func(ctx context.Context, file multipart.File, header *multipart.FileHeader) (*A, error),
	storedBytes func(*A) int64,
	onSkip func(filename string, err error),
) ([]A, int64) {
	attachments := make([]A, 0, len(files))
	var uploaded int64

	for _, header := range files {
		file, err := header.Open()
		if err != nil {
			// Wrapped so the caller can still tell an unreadable part from a storage failure; the
			// two used to carry different messages and the shared callback flattened them.
			onSkip(logSafeFilename(header.Filename), fmt.Errorf("opening the uploaded part: %w", err))
			continue
		}

		attachment, err := store(ctx, file, header)
		file.Close()
		if err != nil {
			onSkip(logSafeFilename(header.Filename), err)
			continue
		}

		uploaded += storedBytes(attachment)
		attachments = append(attachments, *attachment)
	}

	return attachments, uploaded
}

// respondUploadFailure sends the response both strict paths send for a failed upload.
func respondUploadFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, errUnreadableUpload) {
		// The sentinel's own text, not err.Error(): errors.Is matches a wrapped error too, and a
		// wrapper would put internal detail in a client-facing body.
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to read uploaded file")
		return
	}
	pkg.Error(w, err)
}

// logSafeFilename removes the line breaks a client can smuggle into a filename, so one log entry
// stays one line. Everything else is left alone: the point is to keep the name recognisable to
// whoever reads the log, not to sanitise it into uselessness.
func logSafeFilename(name string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(name)
}

// storedSize sums the bytes an attachment put on disk. Both are optional in the model: a row can
// exist before its size is known, and a file may have no preview.
func storedSize(fileSize, thumbSize *int64) int64 {
	var total int64
	if fileSize != nil {
		total += *fileSize
	}
	if thumbSize != nil {
		total += *thumbSize
	}
	return total
}
