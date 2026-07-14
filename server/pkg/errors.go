package pkg

import "errors"

const (
	CodeUploadInfected        = "upload_infected"
	CodeUploadScanUnavailable = "upload_scan_unavailable"
	CodeUploadTooLargeScan    = "upload_too_large_scan"
	CodeUploadTooLarge        = "upload_too_large"

	// Password rejections the client translates — a breach can only be judged server-side.
	CodePasswordTooShort         = "password_too_short"
	CodePasswordContainsIdentity = "password_contains_identity"
	CodePasswordTooLong          = "password_too_long"
	CodePasswordBreached         = "password_breached"
)

type codedError struct {
	code string
	err  error
}

func (e codedError) Error() string { return e.err.Error() }
func (e codedError) Unwrap() error { return e.err }

func WithCode(err error, code string) error {
	return codedError{code: code, err: err}
}

func CodeOf(err error) string {
	var coded codedError
	if errors.As(err, &coded) {
		return coded.code
	}
	return ""
}

// Domain-level sentinel errors.
// Services return these; handlers map them to HTTP status codes.
var (
	ErrNotFound      = errors.New("not found")
	ErrUnauthorized  = errors.New("unauthorized")
	ErrForbidden     = errors.New("forbidden")
	ErrAlreadyExists = errors.New("already exists")
	ErrBadRequest    = errors.New("bad request")
	ErrConflict      = errors.New("conflict") // concurrent write lost the race
	ErrInternal      = errors.New("internal error")
	ErrQuotaExceeded = errors.New("storage quota exceeded")

	// E2EE errors
	ErrDeviceNotFound  = errors.New("device not found")
	ErrPrekeyExhausted = errors.New("prekey pool exhausted")
	ErrInvalidKey      = errors.New("invalid cryptographic key")
)
