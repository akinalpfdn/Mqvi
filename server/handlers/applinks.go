package handlers

import (
	"encoding/json"
	"net/http"
)

// AssetLinksHandler serves the Digital Asset Links statement at
// /.well-known/assetlinks.json. Android fetches it when the app is installed or updated and
// only then will it hand mqvi.net links to the app instead of the browser.
type AssetLinksHandler struct {
	body []byte
}

type assetLinkStatement struct {
	Relation []string        `json:"relation"`
	Target   assetLinkTarget `json:"target"`
}

type assetLinkTarget struct {
	Namespace    string   `json:"namespace"`
	PackageName  string   `json:"package_name"`
	Fingerprints []string `json:"sha256_cert_fingerprints"`
}

// NewAssetLinksHandler builds the statement once — it never changes at runtime. With no
// package or fingerprint the endpoint 404s: serving an empty statement is worse than serving
// none, because Android treats a reachable-but-non-matching statement as a verification
// failure and stops handing us links.
func NewAssetLinksHandler(pkg string, fingerprints []string) *AssetLinksHandler {
	if pkg == "" || len(fingerprints) == 0 {
		return &AssetLinksHandler{}
	}

	body, err := json.Marshal([]assetLinkStatement{{
		Relation: []string{"delegate_permission/common.handle_all_urls"},
		Target: assetLinkTarget{
			Namespace:    "android_app",
			PackageName:  pkg,
			Fingerprints: fingerprints,
		},
	}})
	if err != nil {
		// Unreachable: the value is a plain struct of strings.
		return &AssetLinksHandler{}
	}

	return &AssetLinksHandler{body: body}
}

// Enabled reports whether a statement is configured.
func (h *AssetLinksHandler) Enabled() bool {
	return len(h.body) > 0
}

func (h *AssetLinksHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled() {
		http.NotFound(w, r)
		return
	}

	// Android rejects the statement unless it arrives as JSON over a 200 with no redirect.
	w.Header().Set("Content-Type", "application/json")
	// Short cache: a rotated signing key must not stay shadowed by a CDN copy.
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Write(h.body)
}

// AASAHandler serves the apple-app-site-association statement at
// /.well-known/apple-app-site-association — the iOS counterpart of assetlinks.json.
// Apple's CDN fetches it when the app is installed or updated; only then do tapped
// mqvi.net links open the app (Universal Links) instead of Safari.
type AASAHandler struct {
	body []byte
}

type aasaDocument struct {
	Applinks aasaApplinks `json:"applinks"`
}

type aasaApplinks struct {
	Details []aasaDetail `json:"details"`
}

type aasaDetail struct {
	AppIDs     []string            `json:"appIDs"`
	Components []map[string]string `json:"components"`
}

// NewAASAHandler builds the statement once. appID is "<TeamID>.<BundleID>"
// (e.g. "WQ54PPL5VQ.net.mqvi.app"); empty disables the endpoint with a 404,
// mirroring AssetLinksHandler's semantics.
// The component paths must stay in sync with client/src/utils/deepLink.ts.
func NewAASAHandler(appID string) *AASAHandler {
	if appID == "" {
		return &AASAHandler{}
	}

	body, err := json.Marshal(aasaDocument{
		Applinks: aasaApplinks{
			Details: []aasaDetail{{
				AppIDs: []string{appID},
				Components: []map[string]string{
					{"/": "/invite/*"},
					{"/": "/channels"},
					{"/": "/channels/*"},
				},
			}},
		},
	})
	if err != nil {
		// Unreachable: the value is a plain struct of strings.
		return &AASAHandler{}
	}

	return &AASAHandler{body: body}
}

// Enabled reports whether a statement is configured.
func (h *AASAHandler) Enabled() bool {
	return len(h.body) > 0
}

func (h *AASAHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled() {
		http.NotFound(w, r)
		return
	}

	// Apple requires application/json over a direct 200 — no redirects.
	w.Header().Set("Content-Type", "application/json")
	// Apple's CDN refreshes roughly daily regardless; short cache keeps origin honest.
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Write(h.body)
}
