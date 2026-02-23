// Package models — P2P Call domain modeli.
//
// P2P (peer-to-peer) arama sistemi:
// - "ringing": Arama başlatıldı, karşı taraf henüz yanıtlamadı
// - "active": Arama kabul edildi, WebRTC bağlantısı aktif
// - "ended": Arama sonlandırıldı
//
// CallType:
// - "voice": Sadece sesli arama
// - "video": Görüntülü arama (ses + kamera)
//
// Tüm state ephemeral (in-memory) — DB'ye kaydedilmez.
// Sunucu yeniden başlatılırsa aktif aramalar temizlenir.
package models

import "time"

// P2PCallType, arama türünü temsil eden typed constant.
type P2PCallType string

const (
	P2PCallTypeVoice P2PCallType = "voice"
	P2PCallTypeVideo P2PCallType = "video"
)

// P2PCallStatus, arama durumunu temsil eden typed constant.
type P2PCallStatus string

const (
	P2PCallStatusRinging P2PCallStatus = "ringing"
	P2PCallStatusActive  P2PCallStatus = "active"
	P2PCallStatusEnded   P2PCallStatus = "ended"
)

// P2PCall, bir P2P aramayı temsil eder.
// In-memory olarak tutulur — DB kaydı yoktur.
type P2PCall struct {
	ID         string        `json:"id"`
	CallerID   string        `json:"caller_id"`
	ReceiverID string        `json:"receiver_id"`
	CallType   P2PCallType   `json:"call_type"`
	Status     P2PCallStatus `json:"status"`
	CreatedAt  time.Time     `json:"created_at"`
}

// P2PCallBroadcast, arama event'lerinde broadcast edilen payload.
// Hem caller hem receiver bilgilerini taşır — frontend her iki tarafta da
// karşı tarafın bilgisini gösterir.
type P2PCallBroadcast struct {
	ID                  string        `json:"id"`
	CallerID            string        `json:"caller_id"`
	CallerUsername      string        `json:"caller_username"`
	CallerDisplayName   *string       `json:"caller_display_name"`
	CallerAvatarURL     *string       `json:"caller_avatar"`
	ReceiverID          string        `json:"receiver_id"`
	ReceiverUsername     string        `json:"receiver_username"`
	ReceiverDisplayName *string       `json:"receiver_display_name"`
	ReceiverAvatarURL   *string       `json:"receiver_avatar"`
	CallType            P2PCallType   `json:"call_type"`
	Status              P2PCallStatus `json:"status"`
	CreatedAt           time.Time     `json:"created_at"`
}

// P2PSignalPayload, WebRTC signaling verisi.
// SDP offer/answer veya ICE candidate taşır.
//
// WebRTC nedir?
// Tarayıcılar arası doğrudan (peer-to-peer) ses/video iletişimi sağlayan API.
// Sunucu sadece "signaling" (SDP ve ICE bilgisi alışverişi) için kullanılır.
// Medya (ses/video) doğrudan kullanıcılar arasında akar.
//
// SDP (Session Description Protocol):
// İki tarafın medya yeteneklerini (codec, format) tanımlayan metin.
// "Offer" karşı tarafa önerilir, "Answer" olarak yanıtlanır.
//
// ICE (Interactive Connectivity Establishment):
// NAT arkasındaki cihazların birbirini bulması için kullanılan mekanizma.
// STUN sunucusu ile public IP öğrenilir, ICE candidate olarak karşı tarafa gönderilir.
type P2PSignalPayload struct {
	CallID    string `json:"call_id"`
	Type      string `json:"type"`                // "offer", "answer", "ice-candidate"
	SDP       string `json:"sdp,omitempty"`        // SDP offer veya answer metni
	Candidate any    `json:"candidate,omitempty"`   // RTCIceCandidateInit objesi
}
