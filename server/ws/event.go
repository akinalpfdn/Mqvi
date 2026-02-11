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
)

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
