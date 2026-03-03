// Package models — ChannelMute domain modeli.
//
// ChannelMute, kullanıcının belirli bir kanalı sessize aldığını temsil eder.
// Muted kanallardan bildirim sesi çalmaz ve unread badge gösterilmez.
// MutedUntil nil ise sonsuza kadar sessiz — unmute edilene kadar devam eder.
// MutedUntil belirli bir tarih ise, o tarihten sonra mute otomatik sona erer.
//
// ServerMute ile etkileşim:
//   - Server muted ise tüm kanallar otomatik olarak sessizdir.
//   - Server unmuted ama kanal muted ise, kanal server'ın durumunu ezer ve sessiz kalır.
package models

import (
	"fmt"
	"time"
)

// ChannelMute, bir kullanıcının bir kanalı sessize aldığını temsil eder.
type ChannelMute struct {
	UserID     string     `json:"user_id"`
	ChannelID  string     `json:"channel_id"`
	ServerID   string     `json:"server_id"`
	MutedUntil *time.Time `json:"muted_until"` // nil = sonsuza kadar
	CreatedAt  time.Time  `json:"created_at"`
}

// MuteChannelRequest, kanal sessize alma isteğinin gövdesi.
// Duration alanı geçerli değerler: "1h", "8h", "7d", "forever".
// Aynı validDurations map'ini kullanır (server_mute.go'da tanımlı, aynı package).
type MuteChannelRequest struct {
	Duration string `json:"duration"`
}

// Validate, MuteChannelRequest kontrolü.
func (r *MuteChannelRequest) Validate() error {
	if _, ok := validDurations[r.Duration]; !ok {
		return fmt.Errorf("invalid duration: %s", r.Duration)
	}
	return nil
}

// ParseMutedUntil, duration string'ini *time.Time'a çevirir.
// "forever" → nil, diğerleri → now + duration.
func (r *MuteChannelRequest) ParseMutedUntil() *time.Time {
	d := validDurations[r.Duration]
	if d == 0 {
		return nil // forever
	}
	t := time.Now().UTC().Add(d)
	return &t
}
