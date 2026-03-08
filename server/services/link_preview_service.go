// Package services — LinkPreviewService, URL'lerden Open Graph metadata çeker.
//
// Güvenlik:
//   - SSRF koruması: Private/reserved IP aralıkları engellenir (custom DialContext)
//   - Body limiti: Maksimum 512KB HTML okunur
//   - Timeout: 5 saniye HTTP timeout
//   - Redirect limiti: Maksimum 3 redirect
//
// Cache:
//   - SQLite link_previews tablosunda URL bazlı deduplicated cache
//   - TTL: 24 saat (taze cache doğrudan döner, expired re-fetch)
//   - Hatalı fetch'ler de cache'lenir (error=true) — tekrar denemeyi engeller
//
// Parsing:
//   - <meta property="og:*"> tagları parse edilir
//   - Fallback: <meta name="twitter:*"> tagları
//   - Fallback: <title> elementi
//   - Favicon: <link rel="icon"> veya /favicon.ico
//
// Kullanılan kütüphane: golang.org/x/net/html (Go extended stdlib HTML tokenizer)
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

// LinkPreviewService, URL metadata çekme ve cache yönetimi.
type LinkPreviewService interface {
	// GetPreview, URL'in Open Graph metadata'sını döner.
	// Cache varsa ve taze ise cache'ten döner, yoksa fetch eder.
	GetPreview(ctx context.Context, rawURL string) (*models.LinkPreview, error)
}

// cacheTTL, preview cache süresi.
const cacheTTL = 24 * time.Hour

// maxBodySize, fetch edilecek HTML body limiti (512KB).
const maxBodySize = 512 * 1024

// maxRedirects, izin verilen maksimum redirect sayısı.
const maxRedirects = 3

type linkPreviewService struct {
	repo   repository.LinkPreviewRepository
	client *http.Client
}

// NewLinkPreviewService, constructor.
//
// SSRF korumalı custom HTTP client oluşturur:
// - Private IP aralıkları engellenir (10.x, 172.16-31.x, 192.168.x, 127.x, ::1)
// - DNS çözümleme sonrası IP kontrol edilir (DNS rebinding koruması)
func NewLinkPreviewService(repo repository.LinkPreviewRepository) LinkPreviewService {
	// SSRF-safe dialer: DNS resolve sonrası IP'yi kontrol eder
	safeDialer := &net.Dialer{Timeout: 5 * time.Second}

	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, fmt.Errorf("invalid address: %w", err)
			}

			// DNS resolve
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, fmt.Errorf("DNS lookup failed: %w", err)
			}

			// Tüm çözümlenen IP'leri kontrol et
			for _, ip := range ips {
				if isPrivateIP(ip.IP) {
					return nil, fmt.Errorf("SSRF blocked: %s resolves to private IP %s", host, ip.IP)
				}
			}

			// Güvenli IP — bağlan
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
		// Redirect kontrolü — maxRedirects ile sınırla
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("too many redirects (max %d)", maxRedirects)
			}
			// Redirect hedefini de SSRF kontrolünden geçir
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

// GetPreview, URL'in Open Graph metadata'sını döner.
func (s *linkPreviewService) GetPreview(ctx context.Context, rawURL string) (*models.LinkPreview, error) {
	// 1. URL validation + normalization
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

	// 2. Cache check
	cached, err := s.repo.GetByURL(ctx, normalizedURL)
	if err != nil {
		return nil, fmt.Errorf("cache lookup: %w", err)
	}
	if cached != nil {
		// TTL kontrolü
		fetchedAt, parseErr := time.Parse("2006-01-02 15:04:05", cached.FetchedAt)
		if parseErr == nil && time.Since(fetchedAt) < cacheTTL {
			// Cache taze
			if cached.Error {
				return nil, fmt.Errorf("previously failed URL")
			}
			return cached, nil
		}
		// Cache expired — re-fetch
	}

	// 3. Fetch + parse
	preview, fetchErr := s.fetchAndParse(ctx, normalizedURL, parsed)
	if fetchErr != nil {
		// Hatalı fetch'i de cache'le — tekrar denemeyi engelle
		errPreview := &models.LinkPreview{URL: normalizedURL, Error: true}
		_ = s.repo.Upsert(ctx, errPreview)
		return nil, fetchErr
	}

	// 4. Cache'e kaydet
	if err := s.repo.Upsert(ctx, preview); err != nil {
		// Cache write hatası kritik değil — preview'ı yine de dön
		_ = err
	}

	return preview, nil
}

// fetchAndParse, URL'den HTML çeker ve OG metadata'yı parse eder.
func (s *linkPreviewService) fetchAndParse(ctx context.Context, normalizedURL string, parsed *url.URL) (*models.LinkPreview, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, normalizedURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	// Gerçek bir tarayıcı gibi davran — bazı siteler bot UA'yı engelliyor
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

	// Content-Type kontrolü — sadece HTML parse et
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/html") && !strings.Contains(ct, "application/xhtml") {
		return nil, fmt.Errorf("not HTML: %s", ct)
	}

	// Body limiti
	limitedBody := io.LimitReader(resp.Body, maxBodySize)

	// HTML parse
	og := parseOGMetadata(limitedBody)

	// Relative URL'leri absolute yap
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

	// Favicon fallback: /favicon.ico
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

	// En az title olmalı — yoksa anlamsız preview
	if preview.Title == nil {
		return nil, fmt.Errorf("no OG title found")
	}

	return preview, nil
}

// ogData, parse edilen Open Graph metadata.
type ogData struct {
	title       string
	description string
	imageURL    string
	siteName    string
	faviconURL  string
}

// parseOGMetadata, HTML'den Open Graph / Twitter Card / temel metadata çıkarır.
//
// Parse sırası (öncelik):
// 1. og:title > twitter:title > <title>
// 2. og:description > twitter:description > <meta name="description">
// 3. og:image > twitter:image
// 4. og:site_name
// 5. <link rel="icon"> (favicon)
//
// Tokenizer <body>'ye girdiğinde durur — meta taglar <head>'de olur,
// gereksiz body parsing'den kaçınılır.
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
			// EOF veya hata — parse bitir
			goto done

		case html.StartTagToken, html.SelfClosingTagToken:
			tn, hasAttr := tokenizer.TagName()
			tagName := string(tn)

			switch tagName {
			case "head":
				inHead = true

			case "body":
				// <body>'ye ulaştık, <head> meta parse tamamlandı
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

				// OG tags
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

				// Twitter Card fallback
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
	// Fallback'ler
	if og.title == "" {
		og.title = htmlTitle
	}
	if og.description == "" {
		og.description = metaDesc
	}

	// Truncate — aşırı uzun metadata'yı kırp
	if len(og.title) > 300 {
		og.title = og.title[:300]
	}
	if len(og.description) > 500 {
		og.description = og.description[:500]
	}

	return og
}

// readAttrs, tokenizer'dan tüm attribute'ları okur.
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

// isPrivateIP, IP adresinin private/reserved olup olmadığını kontrol eder.
//
// SSRF koruması için engellenen aralıklar:
//   - 127.0.0.0/8 (loopback)
//   - 10.0.0.0/8 (private)
//   - 172.16.0.0/12 (private)
//   - 192.168.0.0/16 (private)
//   - 169.254.0.0/16 (link-local)
//   - ::1 (IPv6 loopback)
//   - fe80::/10 (IPv6 link-local)
//   - fc00::/7 (IPv6 unique local)
//   - Unspecified (0.0.0.0, ::)
func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	return false
}
