package pkg

import (
	"encoding/json"
	"errors"
	"net/http"
)

// APIResponse, tüm API yanıtları için standart format.
// Frontend her zaman aynı yapıyı bekler — tutarlılık önemli.
type APIResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

// JSON, başarılı bir yanıt gönderir.
// "any" Go'da generic tip — herhangi bir veri tipini kabul eder.
// json tag'leri (`json:"success"`) Go struct field'larının JSON'a nasıl serialize edileceğini belirler.
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

// Error, hata yanıtı gönderir.
// Domain error'ları otomatik olarak uygun HTTP status code'a çevrilir.
func Error(w http.ResponseWriter, err error) {
	status := mapErrorToStatus(err)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	resp := APIResponse{
		Success: false,
		Error:   err.Error(),
	}

	if encErr := json.NewEncoder(w).Encode(resp); encErr != nil {
		http.Error(w, "failed to encode error response", http.StatusInternalServerError)
	}
}

// ErrorWithMessage, özel mesajlı hata yanıtı gönderir.
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

// mapErrorToStatus, domain error'ları HTTP status code'larına eşler.
// errors.Is() kullanarak error chain'ini kontrol eder —
// wrap edilmiş error'lar da doğru match eder.
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
	case errors.Is(err, ErrBadRequest):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}
