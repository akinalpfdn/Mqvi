// MessageRateLimiter — Mesaj spam koruması için kullanıcı bazlı rate limiting.
//
// LoginRateLimiter'dan farklar:
// - Key: userID (IP değil) — authenticated endpoint, kullanıcı bazlı takip.
// - Cooldown: Window süresi ve ceza süresi (cooldown) ayrıdır.
//   Limit aşıldığında kullanıcı cooldown süresi kadar bekler.
//   Login limiter'da cooldown = kalan window süresi idi.
//
// Tasarım:
// - 5 saniye window içinde 5 mesaj → izin verilir.
// - 6. mesajda cooldown başlar → 15 saniye boyunca tüm mesajlar reddedilir.
// - Cooldown bitince window sıfırlanır, kullanıcı tekrar mesaj atabilir.
//
// Neden ayrı struct?
// LoginRateLimiter'ın cooldown mekanizması farklı (window = cooldown).
// Mesaj rate limiting'de window kısa (5sn) ama ceza süresi uzun (15sn).
// Bu iki farklı davranış ayrı struct ile daha temiz ifade edilir.
package ratelimit

import (
	"sync"
	"time"
)

// messageBucket, bir kullanıcı için mesaj sayacı ve cooldown bilgisi tutar.
//
// İki durumlu:
// 1. Normal mod: count artırılır, windowStart bazlı pencere kontrolü.
// 2. Cooldown mod: cooldownUntil > now → tüm mesajlar reddedilir.
type messageBucket struct {
	count         int
	windowStart   time.Time
	cooldownUntil time.Time // zero value = cooldown yok
}

// MessageRateLimiter, kullanıcı bazlı mesaj spam koruması.
//
// maxMessages: Bir window içinde izin verilen maksimum mesaj sayısı.
// window: Sayaç pencere süresi (örn: 5 saniye).
// cooldown: Limit aşıldığında uygulanan ceza süresi (örn: 15 saniye).
//
// Kullanım:
//
//	limiter := NewMessageRateLimiter(5, 5*time.Second, 15*time.Second)
//	// Message handler'da:
//	if !limiter.Allow(userID) { return 429 }
type MessageRateLimiter struct {
	mu          sync.RWMutex
	buckets     map[string]*messageBucket
	maxMessages int
	window      time.Duration
	cooldown    time.Duration
	stopCleanup chan struct{}
}

// NewMessageRateLimiter, yeni mesaj rate limiter oluşturur ve arka plan
// temizleme goroutine'ini başlatır.
//
// maxMessages: Pencere başına izin verilen mesaj sayısı (ör: 5).
// window: Pencere süresi (ör: 5*time.Second → 5 saniyede 5 mesaj).
// cooldown: Limit aşıldığında bekleme süresi (ör: 15*time.Second).
func NewMessageRateLimiter(maxMessages int, window, cooldown time.Duration) *MessageRateLimiter {
	rl := &MessageRateLimiter{
		buckets:     make(map[string]*messageBucket),
		maxMessages: maxMessages,
		window:      window,
		cooldown:    cooldown,
		stopCleanup: make(chan struct{}),
	}

	// Background cleanup — süresi dolmuş bucket'ları temizler.
	// Mesaj bucket'ları kısa ömürlü (5sn window + 15sn cooldown = max 20sn),
	// ama çok sayıda kullanıcıda bellek birikmesini önlemek için gerekli.
	go rl.cleanupLoop()

	return rl
}

// Allow, verilen kullanıcının mesaj göndermesine izin verilip verilmediğini kontrol eder.
//
// true: Mesaj kabul edildi (limit aşılmadı).
// false: Rate limit aşıldı → caller 429 dönmeli.
//
// Akış:
// 1. Cooldown'daysa → reject (cooldown bitmeden hiçbir mesaj geçmez).
// 2. Window dolmuşsa → yeni pencere başlat.
// 3. Window içindeyse → count artır, max aşıldıysa cooldown başlat.
func (rl *MessageRateLimiter) Allow(userID string) bool {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[userID]
	if !exists {
		// İlk mesaj — yeni bucket oluştur
		rl.buckets[userID] = &messageBucket{count: 1, windowStart: now}
		return true
	}

	// Cooldown'da mıyız?
	if !b.cooldownUntil.IsZero() && now.Before(b.cooldownUntil) {
		return false
	}

	// Cooldown bittiyse veya hiç yoksa → cooldown'ı temizle
	if !b.cooldownUntil.IsZero() {
		// Cooldown bitti — yeni pencere başlat
		b.count = 1
		b.windowStart = now
		b.cooldownUntil = time.Time{}
		return true
	}

	// Window süresi dolmuş mu?
	if now.Sub(b.windowStart) > rl.window {
		// Yeni pencere başlat
		b.count = 1
		b.windowStart = now
		return true
	}

	// Window içindeyiz — sayacı artır
	b.count++
	if b.count > rl.maxMessages {
		// Limit aşıldı — cooldown başlat
		b.cooldownUntil = now.Add(rl.cooldown)
		return false
	}

	return true
}

// CooldownSeconds, rate limit aşıldığında kalan cooldown süresini saniye
// cinsinden döner. HTTP Retry-After header değeri olarak kullanılır.
//
// Cooldown yoksa 0 döner.
func (rl *MessageRateLimiter) CooldownSeconds(userID string) int {
	rl.mu.RLock()
	defer rl.mu.RUnlock()

	b, exists := rl.buckets[userID]
	if !exists {
		return 0
	}

	if b.cooldownUntil.IsZero() {
		return 0
	}

	remaining := time.Until(b.cooldownUntil)
	if remaining <= 0 {
		return 0
	}

	// +1 yuvarlama — client'ın tam süreyi beklemesi için
	return int(remaining.Seconds()) + 1
}

// cleanupLoop, arka planda süresi dolmuş bucket'ları temizler.
// Her 30 saniyede bir çalışır. Mesaj bucket'ları kısa ömürlü olduğu için
// login cleanup'tan daha sık çalışır.
func (rl *MessageRateLimiter) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
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
//
// Silme koşulu: hem window süresi geçmiş hem cooldown bitmış (veya hiç yoksa).
// Bu, cooldown'daki kullanıcıların bucket'ını yanlışlıkla silmeyi önler.
func (rl *MessageRateLimiter) cleanup() {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	for userID, b := range rl.buckets {
		windowExpired := now.Sub(b.windowStart) > rl.window
		cooldownExpired := b.cooldownUntil.IsZero() || now.After(b.cooldownUntil)

		if windowExpired && cooldownExpired {
			delete(rl.buckets, userID)
		}
	}
}
