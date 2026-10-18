package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/geoip"
	"github.com/akinalp/mqvi/pkg/password"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/testutil"
)

type recordedLog struct {
	message  string
	metadata map[string]string
}

type recordingAppLogger struct{ entries []recordedLog }

func (l *recordingAppLogger) Log(_ models.LogLevel, _ models.LogCategory, _, _ *string, message string, metadata map[string]string) {
	l.entries = append(l.entries, recordedLog{message, metadata})
}

func postCredentialFailure(t *testing.T, body string) (int, *recordingAppLogger) {
	t.Helper()
	authSvc := services.NewAuthService(
		&testutil.MockUserRepo{}, &testutil.MockSessionRepo{}, &testutil.MockResetRepo{},
		&testutil.MockEventPublisher{}, &testutil.MockEmailSender{}, password.NoopChecker{}, geoip.Noop{},
		"test-secret", []byte("0123456789abcdef0123456789abcdef"), 15, 90, 24,
	)
	logger := &recordingAppLogger{}
	authSvc.SetAppLogger(logger)
	h := NewAuthHandler(authSvc, nil, nil, nil, nil, nil, 0, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/credential-store-failure", strings.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), ctxkeys.User, &models.User{ID: "u1"}))
	rr := httptest.NewRecorder()
	h.CredentialStoreFailure(rr, req)
	return rr.Code, logger
}

func TestCredentialStoreFailure_ShouldLogAValidReport(t *testing.T) {
	code, logger := postCredentialFailure(t,
		`{"operation":"load","reason":"decrypt_failed","platform":"windows","detail":"Error while decrypting the ciphertext"}`)

	if code != http.StatusNoContent {
		t.Fatalf("status %d", code)
	}
	if len(logger.entries) != 1 || logger.entries[0].metadata["reason"] != "decrypt_failed" ||
		logger.entries[0].metadata["detail"] != "Error while decrypting the ciphertext" {
		t.Fatalf("logged %+v", logger.entries)
	}
}

func TestCredentialStoreFailure_ShouldRejectCodesOutsideTheClosedSets(t *testing.T) {
	for _, body := range []string{
		`{"operation":"drop","reason":"decrypt_failed","platform":"windows"}`,
		`{"operation":"load","reason":"anything I like","platform":"windows"}`,
		`{"operation":"load","reason":"decrypt_failed","platform":"amiga"}`,
		`{"operation":"load","reason":"decrypt_failed","platform":"linux","backend":"mine"}`,
	} {
		code, logger := postCredentialFailure(t, body)
		if code != http.StatusBadRequest || len(logger.entries) != 0 {
			t.Fatalf("%s: status %d, logged %d", body, code, len(logger.entries))
		}
	}
}

func TestCredentialStoreFailure_ShouldCapTheDetail(t *testing.T) {
	_, logger := postCredentialFailure(t,
		`{"operation":"save","reason":"encrypt_failed","platform":"macos","detail":"`+strings.Repeat("x", 5000)+`"}`)

	if got := len([]rune(logger.entries[0].metadata["detail"])); got != models.CredentialStoreDetailMax {
		t.Fatalf("detail kept %d runes", got)
	}
}
