package pkg

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
)

// APIResponse is the standard envelope for all API responses.
type APIResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"`
}

func JSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	resp := APIResponse{
		Success: true,
		Data:    data,
	}

	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
	}
}

// Error sends an error response, mapping domain errors to HTTP status codes.
func Error(w http.ResponseWriter, err error) {
	status := mapErrorToStatus(err)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	// Mapped 4xx domain errors carry client-safe messages. The 500 default branch is
	// reached only by unmapped errors, whose text wraps internal/SQL detail — log it
	// server-side and return a generic message so nothing leaks to the client.
	message := err.Error()
	if status == http.StatusInternalServerError {
		log.Printf("internal error: %v", err)
		message = ErrInternal.Error()
	}

	resp := APIResponse{
		Success: false,
		Error:   message,
		Code:    CodeOf(err),
	}

	if encErr := json.NewEncoder(w).Encode(resp); encErr != nil {
		http.Error(w, "failed to encode error response", http.StatusInternalServerError)
	}
}

func ErrorWithMessage(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	resp := APIResponse{
		Success: false,
		Error:   message,
	}

	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, "failed to encode error response", http.StatusInternalServerError)
	}
}

func mapErrorToStatus(err error) int {
	switch {
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, ErrUnauthorized):
		return http.StatusUnauthorized
	case errors.Is(err, ErrForbidden):
		return http.StatusForbidden
	case errors.Is(err, ErrAlreadyExists):
		return http.StatusConflict
	case errors.Is(err, ErrConflict):
		return http.StatusConflict
	case errors.Is(err, ErrBadRequest):
		return http.StatusBadRequest
	case errors.Is(err, ErrQuotaExceeded):
		return http.StatusRequestEntityTooLarge
	default:
		return http.StatusInternalServerError
	}
}
