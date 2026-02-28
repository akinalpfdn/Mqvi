// Package models — LiveKitInstance domain modeli.
//
// Her sunucu bir LiveKit SFU instance'ına bağlıdır.
// "mqvi hosted" sunucular platform'un LiveKit'ini kullanır,
// "self-hosted" sunucular kullanıcının kendi LiveKit'ini kullanır.
//
// Credential'lar (APIKey, APISecret) DB'de AES-256-GCM ile şifrelenmiş saklanır.
// Bu struct'taki değerler decrypt edilmiş haldir — JSON serialize edilirken
// json:"-" tag'i sayesinde asla client'a gönderilmez.
package models

import "time"

// LiveKitInstance, bir LiveKit SFU sunucu bilgisini temsil eder.
type LiveKitInstance struct {
	ID                string    `json:"id"`
	URL               string    `json:"url"`
	APIKey            string    `json:"-"` // asla client'a gönderme
	APISecret         string    `json:"-"` // asla client'a gönderme
	IsPlatformManaged bool      `json:"is_platform_managed"`
	ServerCount       int       `json:"server_count"`
	CreatedAt         time.Time `json:"created_at"`
}
