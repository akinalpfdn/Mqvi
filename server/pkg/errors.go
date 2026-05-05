package pkg

import "errors"

// Domain-level sentinel errors.
// Services return these; handlers map them to HTTP status codes.
var (
	ErrNotFound      = errors.New("not found")
	ErrUnauthorized  = errors.New("unauthorized")
	ErrForbidden     = errors.New("forbidden")
	ErrAlreadyExists = errors.New("already exists")
	ErrBadRequest    = errors.New("bad request")
	ErrInternal      = errors.New("internal error")
	ErrQuotaExceeded = errors.New("storage quota exceeded")

	// E2EE errors
	ErrDeviceNotFound   = errors.New("device not found")
	ErrPrekeyExhausted  = errors.New("prekey pool exhausted")
	ErrInvalidKey       = errors.New("invalid cryptographic key")
)
