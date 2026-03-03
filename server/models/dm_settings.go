// Package models — DM Settings domain modeli.
//
// DMSettings, kullanıcının belirli bir DM kanalı için kişisel ayarlarını tutar:
// - IsHidden: DM'yi sidebar'dan gizle (yeni mesaj gelince otomatik açılır)
// - IsPinned: DM'yi listenin en üstüne sabitle
// - MutedUntil: Bildirim sessize alma süresi
//
// Mute sentinel: user_dm_settings tablosu pin/hide için de satır oluşturabildiğinden,
// muted_until NULL "muted değil" anlamına gelir. "Sonsuz mute" için sentinel datetime
// '9999-12-31T23:59:59Z' kullanılır. Süreli mute ise normal UTC datetime string'i tutar.
// Lazy expiry: WHERE muted_until > datetime('now') ile süresi dolmuş mute'lar filtrelenir.
//
// Tek tablo ile 3 özellik birleştirilir — aynı PK (user_id, dm_channel_id).
// UPSERT pattern kullanılır: ilk etkileşimde satır oluşturulur, sonrakilerde güncellenir.
package models

import (
	"fmt"
	"time"
)

// MuteForeverSentinel, sonsuz mute için kullanılan sentinel datetime string'i.
// SQLite'ta datetime('now') her zaman bundan küçük olacağı için
// WHERE muted_until > datetime('now') koşulu sonsuz mute'ları her zaman dahil eder.
const MuteForeverSentinel = "9999-12-31T23:59:59Z"

// DMSettings, bir kullanıcının bir DM kanalı için kişisel ayarları.
type DMSettings struct {
	UserID      string     `json:"user_id"`
	DMChannelID string     `json:"dm_channel_id"`
	IsHidden    bool       `json:"is_hidden"`
	IsPinned    bool       `json:"is_pinned"`
	MutedUntil  *time.Time `json:"muted_until"` // nil = muted değil, non-nil = muted (forever sentinel veya süreli)
	CreatedAt   time.Time  `json:"created_at"`
}

// MuteDMRequest, DM sessize alma isteğinin gövdesi.
// Duration alanı geçerli değerler: "1h", "8h", "7d", "forever".
// ServerMute pattern'ını birebir takip eder.
type MuteDMRequest struct {
	Duration string `json:"duration"`
}

// validDMDurations, kabul edilen mute süreleri.
// ServerMute ile aynı set — tutarlılık için.
// "forever" → 0 (sentinel ile işaretlenir, gerçek duration değil).
var validDMDurations = map[string]time.Duration{
	"1h":      1 * time.Hour,
	"8h":      8 * time.Hour,
	"7d":      7 * 24 * time.Hour,
	"forever": 0,
}

// Validate, MuteDMRequest kontrolü.
func (r *MuteDMRequest) Validate() error {
	if _, ok := validDMDurations[r.Duration]; !ok {
		return fmt.Errorf("invalid duration: %s", r.Duration)
	}
	return nil
}

// ParseMutedUntil, duration string'ini veritabanına yazılacak *string'e çevirir.
//
// Repo katmanı *string alır (SQLite TEXT column):
// - "forever" → sentinel string "9999-12-31T23:59:59Z" (her zaman > datetime('now'))
// - "1h"/"8h"/"7d" → now + duration, UTC RFC3339 formatında
//
// nil dönmez — mute silme DeleteMute ile yapılır.
func (r *MuteDMRequest) ParseMutedUntil() *string {
	d := validDMDurations[r.Duration]
	if d == 0 {
		s := MuteForeverSentinel
		return &s
	}
	t := time.Now().UTC().Add(d).Format(time.RFC3339)
	return &t
}
