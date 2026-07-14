package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const testFingerprint = "5F:77:05:67:18:C3:4F:77:BE:D8:41:67:BF:A8:46:F1:CA:7E:37:75:C4:7F:0D:FD:30:B7:30:60:9E:74:FC:EF"

func TestAssetLinksServesStatementAndroidAccepts(t *testing.T) {
	h := NewAssetLinksHandler("com.akinalpfdn.mqvi", []string{testFingerprint})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/.well-known/assetlinks.json", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// Android parses the body as JSON and rejects anything else. The SPA fallback used to answer
	// this path with index.html, which is exactly the failure this guards.
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}

	var statements []struct {
		Relation []string `json:"relation"`
		Target   struct {
			Namespace    string   `json:"namespace"`
			PackageName  string   `json:"package_name"`
			Fingerprints []string `json:"sha256_cert_fingerprints"`
		} `json:"target"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &statements); err != nil {
		t.Fatalf("body is not valid JSON: %v — body: %s", err, rec.Body.String())
	}

	if len(statements) != 1 {
		t.Fatalf("got %d statements, want 1", len(statements))
	}
	s := statements[0]
	if len(s.Relation) != 1 || s.Relation[0] != "delegate_permission/common.handle_all_urls" {
		t.Errorf("relation = %v, want [delegate_permission/common.handle_all_urls]", s.Relation)
	}
	if s.Target.Namespace != "android_app" {
		t.Errorf("namespace = %q, want android_app", s.Target.Namespace)
	}
	if s.Target.PackageName != "com.akinalpfdn.mqvi" {
		t.Errorf("package_name = %q, want com.akinalpfdn.mqvi", s.Target.PackageName)
	}
	if len(s.Target.Fingerprints) != 1 || s.Target.Fingerprints[0] != testFingerprint {
		t.Errorf("fingerprints = %v, want [%s]", s.Target.Fingerprints, testFingerprint)
	}
}

func TestAssetLinksCarriesEveryFingerprint(t *testing.T) {
	second := "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
	h := NewAssetLinksHandler("com.akinalpfdn.mqvi", []string{testFingerprint, second})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, assetLinksTestPath, nil))

	var statements []assetLinkStatement
	if err := json.Unmarshal(rec.Body.Bytes(), &statements); err != nil {
		t.Fatalf("body is not valid JSON: %v", err)
	}
	// Both the Play app-signing key and a locally-signed build must verify, or whichever one is
	// missing silently stops opening links.
	if len(statements[0].Target.Fingerprints) != 2 {
		t.Fatalf("fingerprints = %v, want both", statements[0].Target.Fingerprints)
	}
}

func TestAssetLinks404sWhenUnconfigured(t *testing.T) {
	cases := map[string]*AssetLinksHandler{
		"no fingerprint": NewAssetLinksHandler("com.akinalpfdn.mqvi", nil),
		"no package":     NewAssetLinksHandler("", []string{testFingerprint}),
	}

	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			if h.Enabled() {
				t.Fatal("handler reports enabled with an incomplete config")
			}

			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, assetLinksTestPath, nil))

			// A reachable but non-matching statement is a verification failure Android caches.
			// Absent is better: it leaves the domain simply unverified.
			if rec.Code != http.StatusNotFound {
				t.Errorf("status = %d, want 404", rec.Code)
			}
		})
	}
}

const assetLinksTestPath = "/.well-known/assetlinks.json"
