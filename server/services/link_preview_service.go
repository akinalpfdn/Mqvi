// Package services — LinkPreviewService: fetches Open Graph metadata from URLs.
//
// Security:
//   - SSRF protection: private/reserved IP ranges blocked (custom DialContext)
//   - Body limit: max 512KB HTML
//   - Timeout: 5s HTTP timeout
//   - Redirect limit: max 3 redirects
//
// Cache:
//   - SQLite link_previews table, URL-deduplicated, 24h TTL
//   - Failed fetches are also cached to prevent retries
//
// Parsing priority: og:* > twitter:* > <title>/<meta name="description">
package services

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// LinkPreviewService fetches and caches URL metadata.
type LinkPreviewService interface {
	GetPreview(ctx context.Context, rawURL string) (*models.LinkPreview, error)
}

const cacheTTL = 24 * time.Hour
const maxBodySize = 512 * 1024
const maxRedirects = 3

type linkPreviewService struct {
	repo   repository.LinkPreviewRepository
	client *http.Client
}

// NewLinkPreviewService creates a service with an SSRF-safe HTTP client.
// DNS resolution results are checked against private IP ranges.
func NewLinkPreviewService(repo repository.LinkPreviewRepository) LinkPreviewService {
	safeDialer := &net.Dialer{Timeout: 5 * time.Second}

	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, fmt.Errorf("invalid address: %w", err)
			}

			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, fmt.Errorf("DNS lookup failed: %w", err)
			}

			for _, ip := range ips {
				if isPrivateIP(ip.IP) {
					return nil, fmt.Errorf("SSRF blocked: %s resolves to private IP %s", host, ip.IP)
				}
			}

			return safeDialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: false},
		DisableKeepAlives:  true,
		ForceAttemptHTTP2:  false,
		MaxIdleConns:       10,
		IdleConnTimeout:    30 * time.Second,
		DisableCompression: false,
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("too many redirects (max %d)", maxRedirects)
			}
			// SSRF check on redirect target
			host := req.URL.Hostname()
			ips, err := net.DefaultResolver.LookupIPAddr(req.Context(), host)
			if err != nil {
				return fmt.Errorf("redirect DNS lookup failed: %w", err)
			}
			for _, ip := range ips {
				if isPrivateIP(ip.IP) {
					return fmt.Errorf("SSRF blocked on redirect: %s resolves to private IP", host)
				}
			}
			return nil
		},
	}

	return &linkPreviewService{repo: repo, client: client}
}

func (s *linkPreviewService) GetPreview(ctx context.Context, rawURL string) (*models.LinkPreview, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("unsupported scheme: %s", parsed.Scheme)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("empty host")
	}

	normalizedURL := parsed.String()

	// Cache check
	cached, err := s.repo.GetByURL(ctx, normalizedURL)
	if err != nil {
		return nil, fmt.Errorf("cache lookup: %w", err)
	}
	if cached != nil {
		fetchedAt, parseErr := time.Parse("2006-01-02 15:04:05", cached.FetchedAt)
		if parseErr == nil && time.Since(fetchedAt) < cacheTTL {
			if cached.Error {
				return nil, fmt.Errorf("previously failed URL")
			}
			return cached, nil
		}
	}

	preview, fetchErr := s.fetchAndParse(ctx, normalizedURL, parsed)
	if fetchErr != nil {
		// Cache failed fetches to prevent retries
		errPreview := &models.LinkPreview{URL: normalizedURL, Error: true}
		_ = s.repo.Upsert(ctx, errPreview)
		return nil, fetchErr
	}

	// Cache write error is non-critical — still return the preview
	if err := s.repo.Upsert(ctx, preview); err != nil {
		_ = err
	}

	return preview, nil
}

func (s *linkPreviewService) fetchAndParse(ctx context.Context, normalizedURL string, parsed *url.URL) (*models.LinkPreview, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, normalizedURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; MqviBot/1.0; +https://mqvi.net)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/html") && !strings.Contains(ct, "application/xhtml") {
		return nil, fmt.Errorf("not HTML: %s", ct)
	}

	limitedBody := io.LimitReader(resp.Body, maxBodySize)
	og := parseOGMetadata(limitedBody)

	// Resolve relative URLs to absolute
	if og.imageURL != "" && !strings.HasPrefix(og.imageURL, "http") {
		if ref, err := parsed.Parse(og.imageURL); err == nil {
			og.imageURL = ref.String()
		}
	}
	if og.faviconURL != "" && !strings.HasPrefix(og.faviconURL, "http") {
		if ref, err := parsed.Parse(og.faviconURL); err == nil {
			og.faviconURL = ref.String()
		}
	}

	if og.faviconURL == "" {
		og.faviconURL = fmt.Sprintf("%s://%s/favicon.ico", parsed.Scheme, parsed.Host)
	}

	preview := &models.LinkPreview{
		URL:   normalizedURL,
		Error: false,
	}
	if og.title != "" {
		preview.Title = &og.title
	}
	if og.description != "" {
		preview.Description = &og.description
	}
	if og.imageURL != "" {
		preview.ImageURL = &og.imageURL
	}
	if og.siteName != "" {
		preview.SiteName = &og.siteName
	}
	if og.faviconURL != "" {
		preview.FaviconURL = &og.faviconURL
	}

	if preview.Title == nil {
		return nil, fmt.Errorf("no OG title found")
	}

	return preview, nil
}

type ogData struct {
	title       string
	description string
	imageURL    string
	siteName    string
	faviconURL  string
}

// parseOGMetadata extracts OG/Twitter Card metadata from HTML.
// Priority: og:title > twitter:title > <title>, stops at <body>.
func parseOGMetadata(r io.Reader) ogData {
	var og ogData
	var htmlTitle string
	var metaDesc string
	var inTitle bool
	var inHead bool

	tokenizer := html.NewTokenizer(r)

	for {
		tt := tokenizer.Next()
		switch tt {
		case html.ErrorToken:
			goto done

		case html.StartTagToken, html.SelfClosingTagToken:
			tn, hasAttr := tokenizer.TagName()
			tagName := string(tn)

			switch tagName {
			case "head":
				inHead = true

			case "body":
				goto done

			case "title":
				if inHead {
					inTitle = true
				}

			case "meta":
				if !hasAttr {
					continue
				}
				attrs := readAttrs(tokenizer)
				prop := attrs["property"]
				name := attrs["name"]
				content := attrs["content"]

				if content == "" {
					continue
				}

				switch prop {
				case "og:title":
					if og.title == "" {
						og.title = content
					}
				case "og:description":
					if og.description == "" {
						og.description = content
					}
				case "og:image":
					if og.imageURL == "" {
						og.imageURL = content
					}
				case "og:site_name":
					if og.siteName == "" {
						og.siteName = content
					}
				}

				switch name {
				case "twitter:title":
					if og.title == "" {
						og.title = content
					}
				case "twitter:description":
					if og.description == "" {
						og.description = content
					}
				case "twitter:image":
					if og.imageURL == "" {
						og.imageURL = content
					}
				case "description":
					if metaDesc == "" {
						metaDesc = content
					}
				}

			case "link":
				if !hasAttr {
					continue
				}
				attrs := readAttrs(tokenizer)
				rel := strings.ToLower(attrs["rel"])
				href := attrs["href"]
				if href != "" && (rel == "icon" || rel == "shortcut icon") {
					if og.faviconURL == "" {
						og.faviconURL = href
					}
				}
			}

		case html.TextToken:
			if inTitle {
				htmlTitle = strings.TrimSpace(string(tokenizer.Text()))
			}

		case html.EndTagToken:
			tn, _ := tokenizer.TagName()
			if string(tn) == "title" {
				inTitle = false
			}
			if string(tn) == "head" {
				goto done
			}
		}
	}

done:
	if og.title == "" {
		og.title = htmlTitle
	}
	if og.description == "" {
		og.description = metaDesc
	}

	if len(og.title) > 300 {
		og.title = og.title[:300]
	}
	if len(og.description) > 500 {
		og.description = og.description[:500]
	}

	return og
}

func readAttrs(t *html.Tokenizer) map[string]string {
	attrs := make(map[string]string)
	for {
		key, val, more := t.TagAttr()
		if len(key) > 0 {
			attrs[string(key)] = string(val)
		}
		if !more {
			break
		}
	}
	return attrs
}

// isPrivateIP checks if an IP is in a private/reserved range (SSRF protection).
func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	return false
}
