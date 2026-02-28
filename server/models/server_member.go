// Package models — ServerMember domain modeli.
//
// ServerMember, kullanıcı ↔ sunucu üyelik ilişkisini temsil eder.
// Bir kullanıcı birden fazla sunucuya üye olabilir.
// DB'deki "server_members" tablosunun Go karşılığıdır.
package models

import "time"

// ServerMember, bir kullanıcının bir sunucuya üyeliğini temsil eder.
type ServerMember struct {
	ServerID string    `json:"server_id"`
	UserID   string    `json:"user_id"`
	JoinedAt time.Time `json:"joined_at"`
}
