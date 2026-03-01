// Package cache — Generic in-memory TTL cache.
//
// TTLCache, belirli bir süre sonra otomatik olarak süresi dolan kayıtları tutan
// thread-safe, generic bir cache yapısıdır.
//
// Kullanım alanları:
// - Permission resolution sonuçlarını cache'leme (her request'te 3 DB query yerine)
// - Sık erişilen ama nadiren değişen verileri bellekte tutma
//
// TTL (Time To Live) nedir?
// Her cache entry'si bir "son kullanma tarihi" taşır.
// Bu tarih geçtikten sonra entry okunamaz — cache miss olur.
// Stale entry'ler arka planda periyodik olarak veya her yazma sırasında temizlenir.
//
// Thread safety:
// sync.RWMutex ile korunur — birden fazla goroutine aynı anda okuyabilir,
// ama yazma sırasında tüm erişim bloklanır.
package cache

import (
	"sync"
	"time"
)

// entry, cache'teki tek bir kayıttır.
// value: saklanan veri, expiresAt: ne zaman süresi dolacak.
type entry[V any] struct {
	value     V
	expiresAt time.Time
}

// TTLCache, generic in-memory TTL cache.
//
// Generic nedir? (Go 1.18+)
// K ve V tip parametreleridir — cache oluşturulurken concrete tipler belirtilir:
//
//	cache := cache.New[string, int](30*time.Second, 5*time.Minute)
//	cache.Set("key", 42)
//	val, ok := cache.Get("key")
//
// Bu sayede tip güvenliği sağlanır — herhangi bir casting gerekmez.
type TTLCache[K comparable, V any] struct {
	mu      sync.RWMutex
	entries map[K]entry[V]
	ttl     time.Duration

	// stopCleanup: periyodik temizleme goroutine'ini durdurmak için.
	// Close() çağrıldığında bu channel kapatılır.
	stopCleanup chan struct{}
}

// New, yeni bir TTLCache oluşturur ve periyodik temizleme goroutine'ini başlatır.
//
// ttl: her entry'nin yaşam süresi (örn. 30*time.Second)
// cleanupInterval: süresi dolan entry'lerin ne sıklıkla temizleneceği (örn. 5*time.Minute)
//
// cleanupInterval neden ayrı?
// Her Get'te süre kontrolü yapılır (stale entry döndürülmez), ama
// map'ten fiziksel silme periyodik olarak yapılır — bellek sızıntısını önler.
// cleanupInterval < ttl olmalıdır (aksi halde map gereksiz büyür).
func New[K comparable, V any](ttl, cleanupInterval time.Duration) *TTLCache[K, V] {
	c := &TTLCache[K, V]{
		entries:     make(map[K]entry[V]),
		ttl:         ttl,
		stopCleanup: make(chan struct{}),
	}

	// Periyodik temizleme goroutine'i
	go func() {
		ticker := time.NewTicker(cleanupInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				c.evictExpired()
			case <-c.stopCleanup:
				return
			}
		}
	}()

	return c
}

// Get, cache'ten bir değer okur.
//
// Dönen değerler: (value, true) eğer key varsa ve süresi dolmamışsa,
// (zero value, false) aksi halde (key yok veya süresi dolmuş).
//
// Süresi dolan entry bu noktada map'ten silinmez — periyodik cleanup yapar.
// Bu tasarım kararı: Get'i hızlı tutmak için (RLock yeterli, Lock gerekmez).
func (c *TTLCache[K, V]) Get(key K) (V, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expiresAt) {
		var zero V
		return zero, false
	}
	return e.value, true
}

// Set, cache'e bir değer yazar (TTL ile).
func (c *TTLCache[K, V]) Set(key K, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries[key] = entry[V]{
		value:     value,
		expiresAt: time.Now().Add(c.ttl),
	}
}

// Delete, belirli bir key'i cache'ten siler.
//
// Kullanım: Permission override değiştiğinde ilgili cache entry'lerini invalidate etmek.
func (c *TTLCache[K, V]) Delete(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.entries, key)
}

// DeleteByPrefix, belirtilen prefix ile başlayan tüm key'leri siler.
// Sadece string key'li cache'ler için çalışır — diğer tipler için
// DeleteFunc kullanılmalıdır.
//
// Kullanım: Bir kullanıcının TÜM permission cache'ini invalidate etmek
// (rol değişikliğinde "userID:" prefix'i ile eşleşen tüm entry'ler silinir).
func (c *TTLCache[K, V]) DeleteFunc(predicate func(key K) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for key := range c.entries {
		if predicate(key) {
			delete(c.entries, key)
		}
	}
}

// Clear, tüm cache'i boşaltır.
func (c *TTLCache[K, V]) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries = make(map[K]entry[V])
}

// Len, cache'teki toplam entry sayısını döner (süresi dolmuşlar dahil).
func (c *TTLCache[K, V]) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return len(c.entries)
}

// Close, periyodik temizleme goroutine'ini durdurur.
// Cache artık kullanılmayacaksa çağrılmalıdır (goroutine leak önleme).
func (c *TTLCache[K, V]) Close() {
	close(c.stopCleanup)
}

// evictExpired, süresi dolan entry'leri map'ten fiziksel olarak siler.
// Periyodik cleanup goroutine'i tarafından çağrılır.
func (c *TTLCache[K, V]) evictExpired() {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	for key, e := range c.entries {
		if now.After(e.expiresAt) {
			delete(c.entries, key)
		}
	}
}
