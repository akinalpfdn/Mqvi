// Package models, voice (ses) ile ilgili struct tanımlarını içerir.
//
// VoiceState, bir kullanıcının ses kanalındaki durumunu temsil eder.
// Bu veri EPHEMERAL'dır (geçicidir) — veritabanına yazılmaz.
// Go backend'de in-memory map[string]*VoiceState olarak tutulur.
// Server restart'ta tüm WebSocket bağlantıları düşer,
// dolayısıyla voice state'in de sıfırlanması doğaldır.
package models

// VoiceState, bir kullanıcının ses kanalındaki anlık durumu.
//
// Bu struct hem backend in-memory tracking hem de
// WS event payload'ları ve REST API response'ları için kullanılır.
type VoiceState struct {
	UserID           string `json:"user_id"`
	ChannelID        string `json:"channel_id"`
	Username         string `json:"username"`
	DisplayName      string `json:"display_name"`
	AvatarURL        string `json:"avatar_url"`
	IsMuted          bool   `json:"is_muted"`
	IsDeafened       bool   `json:"is_deafened"`
	IsStreaming      bool   `json:"is_streaming"`       // Ekran paylaşımı aktif mi
	IsServerMuted    bool   `json:"is_server_muted"`    // Admin tarafından sunucu genelinde susturulmuş
	IsServerDeafened bool   `json:"is_server_deafened"` // Admin tarafından sunucu genelinde sağırlaştırılmış
}

// VoiceTokenRequest, ses kanalına katılmak için token isteği.
// Client POST /api/voice/token endpoint'ine bu body'yi gönderir.
type VoiceTokenRequest struct {
	ChannelID string `json:"channel_id"`
}

// VoiceTokenResponse, LiveKit token generation yanıtı.
// Client bu bilgilerle doğrudan LiveKit sunucusuna bağlanır.
type VoiceTokenResponse struct {
	Token     string `json:"token"`      // LiveKit JWT — oturum bilgilerini içerir
	URL       string `json:"url"`        // LiveKit WebSocket URL (ws://localhost:7880)
	ChannelID string `json:"channel_id"` // LiveKit room name = channel ID
}
