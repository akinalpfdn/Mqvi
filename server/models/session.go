package models

import "time"

// Session, JWT refresh token oturumunu temsil eder.
//
// Neden refresh token ayrı tabloda?
// Access token kısa ömürlü (15dk) — sık sık yenilenir.
// Refresh token uzun ömürlü (7 gün) — access token yenilemek için kullanılır.
// Refresh token'ları DB'de tutarak:
//   - Çalınan token'ı iptal edebiliriz (revoke)
//   - Kullanıcının tüm oturumlarını görebiliriz
//   - Logout'ta sadece ilgili oturumu silebiliriz
type Session struct {
	ID           string    `json:"id"`
	UserID       string    `json:"user_id"`
	RefreshToken string    `json:"-"` // API'ye gönderilmez
	ExpiresAt    time.Time `json:"expires_at"`
	CreatedAt    time.Time `json:"created_at"`
}
