package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientPolicy_ServesConfiguredMinimums(t *testing.T) {
	h := NewClientPolicyHandler("1.1.0", "")
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodGet, "/api/client-policy", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Data ClientPolicyResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if body.Data.MinVersions.Android != "1.1.0" || body.Data.MinVersions.IOS != "" {
		t.Fatalf("min_versions = %+v, want android 1.1.0 and no iOS minimum", body.Data.MinVersions)
	}
}
