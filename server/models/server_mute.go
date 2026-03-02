// Package models — ServerMute domain modeli.
//
// ServerMute, kullanıcının belirli bir sunucuyu sessize aldığını temsil eder.
// Muted sunuculardan bildirim sesi çalmaz ve unread badge gösterilmez.
// MutedUntil nil ise sonsuza kadar sessiz — unmute edilene kadar devam eder.
// MutedUntil belirli bir tarih ise, o tarihten sonra mute otomatik sona erer.
package models

import (
	"fmt"
	"time"
)

// ServerMute, bir kullanıcının bir sunucuyu sessize aldığını temsil eder.
type ServerMute struct {
	UserID     string     `json:"user_id"`
	ServerID   string     `json:"server_id"`
	MutedUntil *time.Time `json:"muted_until"` // nil = sonsuza kadar
	CreatedAt  time.Time  `json:"created_at"`
}

// MuteServerRequest, sunucu sessize alma isteğinin gövdesi.
// Duration alanı geçerli değerler: "1h", "8h", "7d", "forever".
type MuteServerRequest struct {
	Duration string `json:"duration"`
}

// validDurations, kabul edilen mute süreleri ve karşılık gelen time.Duration değerleri.
// "forever" → 0 (nil olarak yorumlanır).
var validDurations = map[string]time.Duration{
	"1h":      1 * time.Hour,
	"8h":      8 * time.Hour,
	"7d":      7 * 24 * time.Hour,
	"forever": 0,
}

// Validate, MuteServerRequest kontrolü.
func (r *MuteServerRequest) Validate() error {
	if _, ok := validDurations[r.Duration]; !ok {
		return fmt.Errorf("invalid duration: %s", r.Duration)
	}
	return nil
}

// ParseMutedUntil, duration string'ini *time.Time'a çevirir.
// "forever" → nil, diğerleri → now + duration.
func (r *MuteServerRequest) ParseMutedUntil() *time.Time {
	d := validDurations[r.Duration]
	if d == 0 {
		return nil // forever
	}
	t := time.Now().UTC().Add(d)
	return &t
}
