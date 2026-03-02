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
	OpRolesReorder  = "roles_reorder" // Rol sıralaması güncellendi — tam Role[] listesi
	OpServerUpdate = "server_update" // Sunucu bilgileri güncellendi (isim, ikon)
	OpServerCreate = "server_create" // Kullanıcı yeni sunucu oluşturdu veya katıldı
	OpServerDelete = "server_delete" // Sunucu silindi veya kullanıcı ayrıldı

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
	OpDMChannelCreate  = "dm_channel_create"   // Yeni DM kanalı oluşturuldu
	OpDMMessageCreate  = "dm_message_create"   // Yeni DM mesajı gönderildi
	OpDMMessageUpdate  = "dm_message_update"   // DM mesajı düzenlendi
	OpDMMessageDelete  = "dm_message_delete"   // DM mesajı silindi
	OpDMReactionUpdate = "dm_reaction_update"  // DM mesajının reaction listesi güncellendi
	OpDMTypingStart    = "dm_typing_start"     // DM kanalında kullanıcı yazıyor
	OpDMMessagePin     = "dm_message_pin"      // DM mesajı sabitlendi
	OpDMMessageUnpin   = "dm_message_unpin"    // DM mesajı pin'den çıkarıldı

	// Voice (ses kanalı) operasyonları
	OpVoiceStateUpdate = "voice_state_update"  // Bir kullanıcının ses durumu değişti (join/leave/mute/deafen/stream)
	OpVoiceStatesSync  = "voice_states_sync"   // Tüm ses durumlarının bulk sync'i (bağlantı kurulduğunda)

	// Friend (arkadaşlık) operasyonları
	OpFriendRequestCreate  = "friend_request_create"  // Yeni arkadaşlık isteği geldi
	OpFriendRequestAccept  = "friend_request_accept"  // Arkadaşlık isteği kabul edildi
	OpFriendRequestDecline = "friend_request_decline" // Arkadaşlık isteği reddedildi/iptal edildi
	OpFriendRemove         = "friend_remove"          // Arkadaşlıktan çıkarıldı
)

// Client → Server voice operasyonları
const (
	OpVoiceJoin             = "voice_join"                  // Kullanıcı ses kanalına katılmak istiyor
	OpVoiceLeave            = "voice_leave"                 // Kullanıcı ses kanalından ayrılmak istiyor
	OpVoiceStateUpdateReq   = "voice_state_update_request"  // Kullanıcı mute/deafen/stream toggle'lıyor
	OpVoiceAdminStateUpdate = "voice_admin_state_update"    // Admin: kullanıcıyı server mute/deafen
	OpVoiceMoveUser        = "voice_move_user"             // Yetkili: kullanıcıyı başka voice kanala taşı
	OpVoiceDisconnectUser  = "voice_disconnect_user"       // Yetkili: kullanıcıyı voice'tan at
)

// Server → Client voice moderation operasyonları
const (
	OpVoiceForceMove       = "voice_force_move"       // Sen başka kanala taşındın
	OpVoiceForceDisconnect = "voice_force_disconnect"  // Sen voice'tan atıldın
)

// P2P Call operasyonları — hem Client → Server hem Server → Client
//
// P2P (peer-to-peer) arama signaling akışı:
// 1. Caller: p2p_call_initiate → Server validate → Receiver: p2p_call_initiate
// 2. Receiver: p2p_call_accept → Server update → Caller: p2p_call_accept
// 3. WebRTC negotiation: p2p_signal (SDP offer/answer/ICE candidates) relay
// 4. Either: p2p_call_end → Server cleanup → Other: p2p_call_end
const (
	OpP2PCallInitiate = "p2p_call_initiate" // Arama başlat / gelen arama bildirimi
	OpP2PCallAccept   = "p2p_call_accept"   // Arama kabul edildi
	OpP2PCallDecline  = "p2p_call_decline"  // Arama reddedildi / iptal edildi
	OpP2PCallEnd      = "p2p_call_end"      // Arama sonlandırıldı
	OpP2PSignal       = "p2p_signal"        // WebRTC SDP/ICE signaling relay
	OpP2PCallBusy     = "p2p_call_busy"     // Karşı taraf başka bir aramada (meşgul)
)

// ReadyData, bağlantı kurulduğunda client'a gönderilen ilk event'in payload'ı.
//
// Multi-server mimaride ready event kullanıcının sunucu listesini de içerir.
// Frontend bu event ile:
// 1. Sunucu listesini serverStore'a atar (server list sidebar için)
// 2. Online kullanıcıları Set'e atar (presence indicator için)
// 3. Gerekli verileri fetch eder (members, channels vb.)
type ReadyData struct {
	OnlineUserIDs  []string          `json:"online_user_ids"`
	Servers        []ReadyServerItem `json:"servers"`
	MutedServerIDs []string          `json:"muted_server_ids"`
}

// ReadyServerItem, ready event'inde gönderilen minimal sunucu bilgisi.
// ws paketinin models'a bağımlılığını kırmak için ayrı tanımlanır.
type ReadyServerItem struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	IconURL *string `json:"icon_url"`
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

// DMTypingStartData, dm_typing_start event'inin payload'ı.
// DM kanalında birisi yazıyor — sadece kanal katılımcılarına gönderilir.
type DMTypingStartData struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	DMChannelID string `json:"dm_channel_id"`
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

// VoiceAdminStateUpdateData, voice_admin_state_update event'inin Client → Server payload'ı.
// Admin bir kullanıcıyı sunucu genelinde susturma veya sağırlaştırma isteği gönderir.
// Pointer kullanılır — nil ise o alan değiştirilmez (partial update).
type VoiceAdminStateUpdateData struct {
	TargetUserID     string `json:"target_user_id"`
	IsServerMuted    *bool  `json:"is_server_muted,omitempty"`
	IsServerDeafened *bool  `json:"is_server_deafened,omitempty"`
}

// VoiceMoveUserData, voice_move_user event'inin Client → Server payload'ı.
// Yetkili kullanıcı, hedef kullanıcıyı başka bir voice kanala taşır.
type VoiceMoveUserData struct {
	TargetUserID    string `json:"target_user_id"`
	TargetChannelID string `json:"target_channel_id"`
}

// VoiceDisconnectUserData, voice_disconnect_user event'inin Client → Server payload'ı.
// Yetkili kullanıcı, hedef kullanıcıyı voice'tan atar.
type VoiceDisconnectUserData struct {
	TargetUserID string `json:"target_user_id"`
}

// VoiceForceMoveData, voice_force_move event'inin Server → Client payload'ı.
// Kullanıcı başka bir kanala taşındığında alır — client LiveKit room'u değiştirecek.
type VoiceForceMoveData struct {
	ChannelID string `json:"channel_id"` // Taşınılan yeni kanal ID'si
}

// VoiceStateUpdateBroadcast, voice_state_update event'inin payload'ı (Server → Client).
// Bir kullanıcının ses durumu değiştiğinde tüm client'lara broadcast edilir.
type VoiceStateUpdateBroadcast struct {
	UserID           string `json:"user_id"`
	ChannelID        string `json:"channel_id"`
	Username         string `json:"username"`
	DisplayName      string `json:"display_name"`
	AvatarURL        string `json:"avatar_url"`
	IsMuted          bool   `json:"is_muted"`
	IsDeafened       bool   `json:"is_deafened"`
	IsStreaming      bool   `json:"is_streaming"`
	IsServerMuted    bool   `json:"is_server_muted"`
	IsServerDeafened bool   `json:"is_server_deafened"`
	Action           string `json:"action"` // "join", "leave", "update"
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
	UserID           string `json:"user_id"`
	ChannelID        string `json:"channel_id"`
	Username         string `json:"username"`
	DisplayName      string `json:"display_name"`
	AvatarURL        string `json:"avatar_url"`
	IsMuted          bool   `json:"is_muted"`
	IsDeafened       bool   `json:"is_deafened"`
	IsStreaming      bool   `json:"is_streaming"`
	IsServerMuted    bool   `json:"is_server_muted"`
	IsServerDeafened bool   `json:"is_server_deafened"`
}

// ─── P2P Call Event Data Struct'ları ───

// P2PCallInitiateData, p2p_call_initiate event'inin Client → Server payload'ı.
// Caller bu event'i gönderir, server validate edip receiver'a iletir.
type P2PCallInitiateData struct {
	ReceiverID string `json:"receiver_id"`
	CallType   string `json:"call_type"` // "voice" veya "video"
}

// P2PCallAcceptData, p2p_call_accept event'inin Client → Server payload'ı.
type P2PCallAcceptData struct {
	CallID string `json:"call_id"`
}

// P2PCallDeclineData, p2p_call_decline event'inin Client → Server payload'ı.
type P2PCallDeclineData struct {
	CallID string `json:"call_id"`
}

// P2PSignalData, p2p_signal event'inin Client → Server payload'ı.
// WebRTC SDP offer/answer veya ICE candidate taşır.
// Server bunu doğrudan karşı tarafa relay eder — içeriğine bakmaz.
type P2PSignalData struct {
	CallID    string `json:"call_id"`
	Type      string `json:"type"`                // "offer", "answer", "ice-candidate"
	SDP       string `json:"sdp,omitempty"`        // SDP metni (offer/answer için)
	Candidate any    `json:"candidate,omitempty"`   // RTCIceCandidateInit (ICE için)
}
