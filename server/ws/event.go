// Package ws, WebSocket bağlantı yönetimi ve gerçek zamanlı event dağıtımını sağlar.
//
// Mimari:
// - Hub: Tüm bağlantıları yöneten merkezi yapı (Observer pattern)
// - Client: Her WebSocket bağlantısını temsil eder
// - Event: Client-server arası iletilen mesaj formatı
//
// Event akışı:
// 1. Kullanıcı mesaj gönderir → HTTP POST → Service → DB kayıt
// 2. Service, Hub'ın BroadcastToAll metodunu çağırır
// 3. Hub, event'i tüm bağlı client'lara iletir
// 4. Her client'ın WritePump'ı event'i WebSocket'e yazar
// 5. Frontend useWebSocket hook'u event'i alır ve store'u günceller
package ws

// Event, WebSocket üzerinden iletilen bir mesajı temsil eder.
//
// Op (operation): Event türü — "message_create", "heartbeat" vb.
// Data: Event'e özgü payload — mesaj objesi, kanal bilgisi vb.
// Seq (sequence number): Her outbound event'e verilen artan sayı.
//   Frontend eksik event tespit etmek için seq'i takip eder.
//   Örnek: seq 5'ten sonra seq 7 gelirse, 6 kaybolmuş demektir.
type Event struct {
	Op   string `json:"op"`
	Data any    `json:"d,omitempty"`
	Seq  int64  `json:"seq,omitempty"`
}

// ────────────────────────────────────────────
// Operation sabitleri
// ────────────────────────────────────────────

// Client → Server operasyonları
const (
	OpHeartbeat      = "heartbeat"       // Client her 30sn'de gönderir — "hâlâ bağlıyım" sinyali
	OpTyping         = "typing"          // Kullanıcı yazıyor
	OpPresenceUpdate = "presence_update" // Durum değişikliği (online/idle/dnd)
)

// Server → Client operasyonları
const (
	OpReady         = "ready"          // Bağlantı kurulduğunda ilk gönderilen — kullanıcı + kanal + üye bilgileri
	OpHeartbeatAck  = "heartbeat_ack"  // Heartbeat'e yanıt — "seni duydum"
	OpMessageCreate = "message_create" // Yeni mesaj oluşturuldu
	OpMessageUpdate = "message_update" // Mesaj düzenlendi
	OpMessageDelete = "message_delete" // Mesaj silindi
	OpChannelCreate  = "channel_create"  // Yeni kanal oluşturuldu
	OpChannelUpdate  = "channel_update"  // Kanal düzenlendi
	OpChannelDelete  = "channel_delete"  // Kanal silindi
	OpCategoryCreate = "category_create" // Yeni kategori oluşturuldu
	OpCategoryUpdate = "category_update" // Kategori düzenlendi
	OpCategoryDelete = "category_delete" // Kategori silindi
	OpTypingStart    = "typing_start"    // Bir kullanıcı yazıyor
	OpPresence      = "presence_update"
	OpMemberJoin    = "member_join"    // Yeni üye katıldı
	OpMemberLeave   = "member_leave"   // Üye ayrıldı
	OpMemberUpdate  = "member_update"  // Üye bilgileri güncellendi (rol değişikliği, profil güncelleme)
	OpRoleCreate    = "role_create"    // Yeni rol oluşturuldu
	OpRoleUpdate    = "role_update"    // Rol güncellendi
	OpRoleDelete    = "role_delete"    // Rol silindi
	OpServerUpdate  = "server_update" // Sunucu bilgileri güncellendi (isim, ikon)

	// Pin (mesaj sabitleme) operasyonları
	OpMessagePin   = "message_pin"   // Mesaj sabitlendi
	OpMessageUnpin = "message_unpin" // Mesaj pin'den çıkarıldı

	// Reaction (emoji tepki) operasyonları
	OpReactionUpdate = "reaction_update" // Mesajın reaction listesi güncellendi

	// Channel permission override operasyonları
	OpChannelPermissionUpdate = "channel_permission_update" // Kanal permission override oluşturuldu/güncellendi
	OpChannelPermissionDelete = "channel_permission_delete" // Kanal permission override silindi

	// Channel reorder (kanal sıralama)
	OpChannelReorder = "channel_reorder" // Kanal sıralaması güncellendi — tam CategoryWithChannels[] listesi

	// DM (Direct Messages) operasyonları
	OpDMChannelCreate = "dm_channel_create"  // Yeni DM kanalı oluşturuldu
	OpDMMessageCreate = "dm_message_create"  // Yeni DM mesajı gönderildi
	OpDMMessageUpdate = "dm_message_update"  // DM mesajı düzenlendi
	OpDMMessageDelete = "dm_message_delete"  // DM mesajı silindi

	// Voice (ses kanalı) operasyonları
	OpVoiceStateUpdate = "voice_state_update"  // Bir kullanıcının ses durumu değişti (join/leave/mute/deafen/stream)
	OpVoiceStatesSync  = "voice_states_sync"   // Tüm ses durumlarının bulk sync'i (bağlantı kurulduğunda)
)

// Client → Server voice operasyonları
const (
	OpVoiceJoin           = "voice_join"                  // Kullanıcı ses kanalına katılmak istiyor
	OpVoiceLeave          = "voice_leave"                 // Kullanıcı ses kanalından ayrılmak istiyor
	OpVoiceStateUpdateReq = "voice_state_update_request"  // Kullanıcı mute/deafen/stream toggle'lıyor
)

// ReadyData, bağlantı kurulduğunda client'a gönderilen ilk event'in payload'ı.
//
// Frontend bu event ile:
// 1. Online kullanıcıları Set'e atar (presence indicator için)
// 2. Gerekli verileri fetch eder (members, channels vb.)
type ReadyData struct {
	OnlineUserIDs []string `json:"online_user_ids"`
}

// PresenceData, bir kullanıcının online durumu değiştiğinde broadcast edilen payload.
type PresenceData struct {
	UserID string `json:"user_id"`
	Status string `json:"status"`
}

// TypingData, typing event'inin payload'ı.
type TypingData struct {
	ChannelID string `json:"channel_id"`
}

// TypingStartData, typing_start event'inin payload'ı (broadcast edilen).
type TypingStartData struct {
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
	ChannelID string `json:"channel_id"`
}

// ─── Voice Event Data Struct'ları ───

// VoiceJoinData, voice_join event'inin payload'ı (Client → Server).
type VoiceJoinData struct {
	ChannelID string `json:"channel_id"`
}

// VoiceStateUpdateRequestData, voice_state_update_request payload'ı (Client → Server).
// Pointer kullanılır — nil ise o alan değiştirilmez (partial update).
type VoiceStateUpdateRequestData struct {
	IsMuted    *bool `json:"is_muted,omitempty"`
	IsDeafened *bool `json:"is_deafened,omitempty"`
	IsStreaming *bool `json:"is_streaming,omitempty"`
}

// VoiceStateUpdateBroadcast, voice_state_update event'inin payload'ı (Server → Client).
// Bir kullanıcının ses durumu değiştiğinde tüm client'lara broadcast edilir.
type VoiceStateUpdateBroadcast struct {
	UserID      string `json:"user_id"`
	ChannelID   string `json:"channel_id"`
	Username    string `json:"username"`
	AvatarURL   string `json:"avatar_url"`
	IsMuted     bool   `json:"is_muted"`
	IsDeafened  bool   `json:"is_deafened"`
	IsStreaming bool   `json:"is_streaming"`
	Action      string `json:"action"` // "join", "leave", "update"
}

// VoiceStatesSyncData, voice_states_sync event'inin payload'ı (Server → Client).
// Bağlantı kurulduğunda tüm aktif ses durumlarını client'a gönderir.
type VoiceStatesSyncData struct {
	States []VoiceStateItem `json:"states"`
}

// VoiceStateItem, sync payload'ındaki tek bir voice state.
// models.VoiceState ile aynı alanları taşır — ws paketinin models'a
// bağımlılığını kırmak için ayrı tanımlanır.
type VoiceStateItem struct {
	UserID      string `json:"user_id"`
	ChannelID   string `json:"channel_id"`
	Username    string `json:"username"`
	AvatarURL   string `json:"avatar_url"`
	IsMuted     bool   `json:"is_muted"`
	IsDeafened  bool   `json:"is_deafened"`
	IsStreaming bool   `json:"is_streaming"`
}
