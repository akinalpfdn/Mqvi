// Package ratelimit — LoginRateLimiter: brute-force saldırılarına karşı
// IP bazlı login rate limiting.
//
// Tasarım:
// - Her IP adresi için sliding window ile istek sayısı takip edilir.
// - Window süresi içinde maxAttempts aşılırsa istek reddedilir.
// - Başarılı login sonrası Reset() ile sayaç sıfırlanır.
// - Background goroutine ile süresi dolmuş bucket'lar temizlenir (memory leak engeli).
//
// Neden in-memory?
// - SQLite'a her request'te yazma gereksiz I/O + contention yaratır.
// - Redis bağımlılığı eklememek için in-memory yeterli (tek instance deploy).
// - sync.RWMutex ile thread-safe: RLock okuma, Lock yazma.
//
// Neden ayrı paket?
// handlers ↔ middleware arasında import cycle oluşmaması için
// rate limiter bağımsız bir paket olarak konumlandırıldı.
// pkg/ratelimit hiçbir proje içi pakete bağımlı değildir (leaf dependency).
package ratelimit

import (
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

// bucket, bir IP adresi için istek sayacı ve window başlangıç zamanı tutar.
//
// Sliding window algoritması:
// - İlk istek geldiğinde windowStart = now, count = 1.
// - Sonraki istekler: windowStart + window süresi geçmemişse count++.
// - Süre geçmişse window sıfırlanır (yeni pencere başlar).
type bucket struct {
	count       int
	windowStart time.Time
}

// LoginRateLimiter, IP bazlı login rate limiting.
//
// maxAttempts: Bir window içinde izin verilen maksimum istek sayısı.
// window: Rate limit pencere süresi (örn: 2 dakika).
//
// Kullanım:
//
//	limiter := NewLoginRateLimiter(5, 2*time.Minute)
//	// Login handler'da:
//	if !limiter.Allow(ip) { return 429 }
//	// Başarılı login'de:
//	limiter.Reset(ip)
type LoginRateLimiter struct {
	mu          sync.RWMutex
	buckets     map[string]*bucket
	maxAttempts int
	window      time.Duration
	stopCleanup chan struct{}
}

// NewLoginRateLimiter, yeni rate limiter oluşturur ve arka plan temizleme
// goroutine'ini başlatır.
//
// maxAttempts: Pencere başına izin verilen login denemesi (ör: 5).
// window: Pencere süresi (ör: 2*time.Minute → 2 dakikada 5 deneme).
//
// Temizleme goroutine'i her dakika çalışır ve süresi dolmuş bucket'ları siler.
// Bu, uzun süre çalışan sunucularda bellek sızıntısını önler.
func NewLoginRateLimiter(maxAttempts int, window time.Duration) *LoginRateLimiter {
	rl := &LoginRateLimiter{
		buckets:     make(map[string]*bucket),
		maxAttempts: maxAttempts,
		window:      window,
		stopCleanup: make(chan struct{}),
	}

	// Background cleanup goroutine — süresi dolmuş bucket'ları temizler.
	// Goroutine: Go'da lightweight thread. go keyword ile başlatılır.
	// Bu goroutine sunucu kapanana kadar çalışır, her dakika map'i tarar.
	go rl.cleanupLoop()

	return rl
}

// Allow, verilen IP adresinin login denemesine izin verilip verilmediğini kontrol eder.
//
// true: İstek kabul edildi (limit aşılmadı).
// false: Rate limit aşıldı → caller 429 dönmeli.
//
// Her çağrı sayacı artırır (istek başarılı olsun veya olmasın).
// Başarılı login'de caller Reset() çağırmalıdır.
func (rl *LoginRateLimiter) Allow(ip string) bool {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[ip]
	if !exists {
		// İlk istek — yeni bucket oluştur
		rl.buckets[ip] = &bucket{count: 1, windowStart: now}
		return true
	}

	// Window süresi dolmuş mu?
	if now.Sub(b.windowStart) > rl.window {
		// Yeni pencere başlat — eski sayaç sıfırlanır
		b.count = 1
		b.windowStart = now
		return true
	}

	// Window içindeyiz — sayacı artır
	b.count++
	return b.count <= rl.maxAttempts
}

// Reset, başarılı login sonrası IP sayacını sıfırlar.
//
// Bu fonksiyon önemli: Başarılı giriş yapan kullanıcının sayacı
// temizlenmezse, meşru kullanıcı sonraki denemelerde bloke olabilir.
func (rl *LoginRateLimiter) Reset(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.buckets, ip)
}

// RetryAfterSeconds, rate limit aşıldığında kalan bekleme süresini saniye
// cinsinden döner. HTTP Retry-After header değeri olarak kullanılır.
func (rl *LoginRateLimiter) RetryAfterSeconds(ip string) int {
	rl.mu.RLock()
	defer rl.mu.RUnlock()

	b, exists := rl.buckets[ip]
	if !exists {
		return 0
	}

	remaining := rl.window - time.Since(b.windowStart)
	if remaining < 0 {
		return 0
	}
	seconds := int(remaining.Seconds()) + 1 // +1 yuvarlama — client'ın tam süreyi beklemesi için
	return seconds
}

// cleanupLoop, arka planda süresi dolmuş bucket'ları temizler.
// Her 60 saniyede bir çalışır, window süresi geçmiş tüm IP'leri siler.
func (rl *LoginRateLimiter) cleanupLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.cleanup()
		case <-rl.stopCleanup:
			return
		}
	}
}

// cleanup, süresi dolmuş tüm bucket'ları siler.
func (rl *LoginRateLimiter) cleanup() {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	for ip, b := range rl.buckets {
		if now.Sub(b.windowStart) > rl.window {
			delete(rl.buckets, ip)
		}
	}
}

// ExtractIP, HTTP request'ten client IP adresini çıkarır.
//
// Öncelik sırası:
// 1. X-Forwarded-For header (reverse proxy arkasındaysa, ilk IP)
// 2. X-Real-IP header (nginx gibi proxy'ler ekler)
// 3. RemoteAddr (doğrudan bağlantı)
//
// Neden bu sıra?
// Production'da uygulama genellikle nginx/Caddy arkasındadır.
// Bu durumda RemoteAddr her zaman proxy'nin IP'sidir.
// Gerçek client IP'si X-Forwarded-For veya X-Real-IP'dedir.
func ExtractIP(r *http.Request) string {
	// X-Forwarded-For: client, proxy1, proxy2 — ilk değer gerçek client
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Virgülle ayrılmış listeden ilk IP'yi al
		for i := 0; i < len(xff); i++ {
			if xff[i] == ',' {
				return xff[:i]
			}
		}
		return xff
	}

	// X-Real-IP: tek IP adresi
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}

	// Doğrudan bağlantı — host:port formatından host'u ayır
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// FormatRetryMessage, kalan süreyi okunabilir formata çevirir.
// Örn: "120" → "2 minutes", "45" → "45 seconds"
func FormatRetryMessage(seconds int) string {
	if seconds >= 60 {
		minutes := seconds / 60
		return fmt.Sprintf("%d minute(s)", minutes)
	}
	return fmt.Sprintf("%d second(s)", seconds)
}
