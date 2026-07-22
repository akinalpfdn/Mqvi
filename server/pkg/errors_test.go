package pkg

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func decodeEnvelope(t *testing.T, rec *httptest.ResponseRecorder) APIResponse {
	t.Helper()
	var resp APIResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.String(), err)
	}
	return resp
}

// Attaching a code must not hide the sentinel underneath it.
//
// The status mapping is a chain of errors.Is against the sentinels, so a coded error that stopped
// unwrapping would fall through to the 500 default: every "this server requires encrypted
// messages" would reach the client as an internal error, with no code and a generic message. The
// service layer would look correct and the whole failure would live in this one method.
func TestWithCode_KeepsTheSentinelMatchable(t *testing.T) {
	base := fmt.Errorf("%w: this server requires end-to-end encrypted messages", ErrBadRequest)

	coded := WithCode(base, CodeEncryptionRequired)

	if !errors.Is(coded, ErrBadRequest) {
		t.Fatal("a coded error no longer matches its sentinel — it would map to 500 instead of 400")
	}
	if CodeOf(coded) != CodeEncryptionRequired {
		t.Errorf("CodeOf = %q, want %q", CodeOf(coded), CodeEncryptionRequired)
	}
}

// The message belongs to the error underneath. A code is metadata for the client, not text.
func TestWithCode_LeavesTheMessageAlone(t *testing.T) {
	base := fmt.Errorf("%w: password was found in a breach", ErrBadRequest)

	if got := WithCode(base, CodePasswordBreached).Error(); got != base.Error() {
		t.Errorf("message = %q, want %q — the code must not appear in user-facing text", got, base.Error())
	}
}

// Services wrap what they call, so the coded error is rarely the outermost one by the time a
// handler sees it.
func TestCodeOf_FindsTheCodeThroughFurtherWrapping(t *testing.T) {
	coded := WithCode(fmt.Errorf("%w: too large", ErrBadRequest), CodeUploadTooLarge)
	wrapped := fmt.Errorf("upload attachment: %w", fmt.Errorf("scan file: %w", coded))

	if got := CodeOf(wrapped); got != CodeUploadTooLarge {
		t.Errorf("CodeOf = %q, want %q — the client loses the reason it shows", got, CodeUploadTooLarge)
	}
	if !errors.Is(wrapped, ErrBadRequest) {
		t.Error("the sentinel stopped matching once the coded error was wrapped")
	}
}

func TestCodeOf_IsEmptyForAnUncodedError(t *testing.T) {
	if got := CodeOf(fmt.Errorf("%w: nothing special", ErrNotFound)); got != "" {
		t.Errorf("CodeOf = %q, want empty", got)
	}
	if got := CodeOf(nil); got != "" {
		t.Errorf("CodeOf(nil) = %q, want empty", got)
	}
}

// The contract end to end, which is the only form the client ever sees: a coded domain error has to
// arrive as its own status, its own message and its code.
func TestError_CodedDomainErrorKeepsStatusMessageAndCode(t *testing.T) {
	rec := httptest.NewRecorder()
	err := WithCode(
		fmt.Errorf("%w: this server does not use end-to-end encryption", ErrBadRequest),
		CodeEncryptionNotAvailable,
	)

	Error(rec, err)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	resp := decodeEnvelope(t, rec)
	if resp.Code != CodeEncryptionNotAvailable {
		t.Errorf("code = %q, want %q — the client falls back to a generic failure without it", resp.Code, CodeEncryptionNotAvailable)
	}
	if resp.Error != err.Error() {
		t.Errorf("message = %q, want %q", resp.Error, err.Error())
	}
}

// Every sentinel the mapper knows, so a status that quietly changes is visible here rather than in
// a client that stops retrying — or starts.
func TestError_MapsEverySentinelToItsStatus(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"not found", ErrNotFound, http.StatusNotFound},
		{"unauthorized", ErrUnauthorized, http.StatusUnauthorized},
		{"forbidden", ErrForbidden, http.StatusForbidden},
		{"already exists", ErrAlreadyExists, http.StatusConflict},
		{"conflict", ErrConflict, http.StatusConflict},
		{"bad request", ErrBadRequest, http.StatusBadRequest},
		{"quota exceeded", ErrQuotaExceeded, http.StatusRequestEntityTooLarge},
		{"unmapped", errors.New("something internal"), http.StatusInternalServerError},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			Error(rec, tc.err)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d", rec.Code, tc.want)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", ct)
			}
		})
	}
}

func TestJSON_WrapsTheDataInASuccessEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()

	JSON(rec, http.StatusCreated, map[string]string{"id": "m1"})

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	resp := decodeEnvelope(t, rec)
	if !resp.Success {
		t.Error("success = false on a JSON response")
	}
	if resp.Error != "" || resp.Code != "" {
		t.Errorf("a success envelope carried error=%q code=%q", resp.Error, resp.Code)
	}
	data, ok := resp.Data.(map[string]any)
	if !ok || data["id"] != "m1" {
		t.Errorf("data = %v, want the payload back", resp.Data)
	}
}

func TestErrorWithMessage_SendsTheGivenTextAndStatus(t *testing.T) {
	rec := httptest.NewRecorder()

	ErrorWithMessage(rec, http.StatusTooManyRequests, "too many messages, please wait 30 seconds")

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	resp := decodeEnvelope(t, rec)
	if resp.Success {
		t.Error("success = true on an error response")
	}
	if resp.Error != "too many messages, please wait 30 seconds" {
		t.Errorf("message = %q, want the text it was given", resp.Error)
	}
}
