package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/pkg/fileacl"
	"github.com/akinalp/mqvi/pkg/signedurl"
	"github.com/akinalp/mqvi/testutil"
)

// Which auth routes sit behind the access-token gate is part of the session contract: logout must
// not (an offline sign-out is sent after the access token lapsed), the devices endpoints must.
func TestRoutes_ShouldGateTheSessionEndpointsAsTheContractSays(t *testing.T) {
	mux := http.NewServeMux()
	h := &Handlers{Auth: handlers.NewAuthHandler(fileTokenAuthStub{}, nil, nil, nil, nil, nil, 0, nil)}
	initRoutes(mux, h, fileTokenAuthStub{}, &testutil.MockUserRepo{}, nil, nil,
		signedurl.NewSigner([]byte("0123456789abcdef0123456789abcdef"), nil), fileacl.NewChecker(nil, nil, nil, nil, nil, nil, nil))

	call := func(method, path, body string) int {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec.Code
	}

	// Reaching the handler (it rejects the body) proves no access-token gate in front of it.
	if got := call(http.MethodPost, "/api/auth/logout", "not json"); got != http.StatusBadRequest {
		t.Fatalf("logout without an access token: %d, want the handler's 400", got)
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/auth/sessions"},
		{http.MethodDelete, "/api/auth/sessions"},
		{http.MethodDelete, "/api/auth/sessions/s1"},
		{http.MethodPost, "/api/auth/credential-store-failure"},
	} {
		if got := call(route.method, route.path, "{}"); got != http.StatusUnauthorized {
			t.Fatalf("%s %s without an access token: %d, want 401", route.method, route.path, got)
		}
	}
}
