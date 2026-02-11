package ws

import (
	"context"
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/akinalp/mqvi/models"
)

// TokenValidator, WebSocket handler'ın JWT doğrulaması için kullandığı interface.
//
// Neden services.AuthService yerine kendi interface'imizi tanımlıyoruz?
// Circular dependency'yi önlemek için:
// - services paketi ws.EventPublisher'ı kullanıyor (broadcast için)
// - ws paketi services.AuthService'i kullansaydı → ws → services → ws döngüsü oluşurdu
//
// Interface Segregation Principle (ISP):
// WS handler'ın AuthService'in tüm metodlarına (Register, Login, Logout, vb.) ihtiyacı yok.
// Sadece ValidateAccessToken yeterli. Küçük, odaklı bir interface tanımlıyoruz.
// main.go'da authService bu interface'i otomatik olarak karşılar (Go'da implicit interface).
type TokenValidator interface {
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)
}

// BanChecker, kullanıcının banlı olup olmadığını kontrol eden interface (ISP).
//
// MemberService'in IsBanned metodunu karşılar.
// WS paketi service paketine bağımlı olamaz (circular dependency),
// bu yüzden küçük bir interface tanımlıyoruz.
type BanChecker interface {
	IsBanned(ctx context.Context, userID string) (bool, error)
}

// VoiceStatesProvider, aktif ses durumlarını sorgulayan interface (ISP).
//
// VoiceService'in GetAllVoiceStates metodunu karşılar.
// Bağlantı kurulduğunda (ready event) tüm aktif voice state'leri
// client'a göndermek için kullanılır.
type VoiceStatesProvider interface {
	GetAllVoiceStates() []models.VoiceState
}

// upgrader, HTTP bağlantısını WebSocket bağlantısına yükseltir.
//
// WebSocket Upgrade nedir?
// WebSocket, normal HTTP bağlantısı olarak başlar ve "upgrade" ile
// kalıcı, çift yönlü (bidirectional) bir bağlantıya dönüşür.
// HTTP: istek → yanıt → bağlantı kapanır
// WebSocket: bağlantı açık kalır, her iki taraf istediği zaman mesaj gönderebilir
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// CheckOrigin: Production'da domain kontrolü yapılmalı.
	// Şimdilik tüm origin'lere izin veriyoruz (development için).
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Handler, WebSocket bağlantı isteklerini işleyen HTTP handler'ı.
type Handler struct {
	hub                 *Hub
	tokenValidator      TokenValidator
	banChecker          BanChecker
	voiceStatesProvider VoiceStatesProvider
}

// NewHandler, yeni bir WebSocket handler oluşturur.
//
// tokenValidator parametresi TokenValidator interface'ini karşılayan herhangi bir
// struct olabilir. Pratikte bu authService'dir — Go'da interface'ler implicit'tir,
// yani authService.ValidateAccessToken metodu varsa otomatik olarak karşılar.
//
// banChecker parametresi BanChecker interface'ini karşılar (pratikte memberService).
// Banlı kullanıcıların WS bağlantısı kurmasını engeller.
//
// voiceStatesProvider parametresi VoiceStatesProvider interface'ini karşılar
// (pratikte voiceService). Bağlantı kurulduğunda aktif voice state'leri gönderir.
func NewHandler(hub *Hub, tokenValidator TokenValidator, banChecker BanChecker, voiceStatesProvider VoiceStatesProvider) *Handler {
	return &Handler{
		hub:                 hub,
		tokenValidator:      tokenValidator,
		banChecker:          banChecker,
		voiceStatesProvider: voiceStatesProvider,
	}
}

// HandleConnection, HTTP bağlantısını WebSocket'e yükseltir ve client'ı Hub'a kaydeder.
//
// Neden normal auth middleware kullanmıyoruz?
// WebSocket bağlantısında HTTP header göndermek zordur (tarayıcı sınırlaması).
// Bu yüzden token URL query parameter'ı olarak gönderilir:
//
//	ws://server/ws?token=JWT_TOKEN
//
// Flow:
// 1. Query'den token al
// 2. Token'ı doğrula (JWT imza kontrolü)
// 3. Ban kontrolü
// 4. HTTP → WebSocket upgrade
// 5. Client oluştur, Hub'a kaydet
// 6. "ready" event gönder (online kullanıcı listesi)
// 7. ReadPump ve WritePump goroutine'lerini başlat
func (h *Handler) HandleConnection(w http.ResponseWriter, r *http.Request) {
	// 1. Token'ı query parameter'dan al
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}

	// 2. JWT token'ı doğrula
	claims, err := h.tokenValidator.ValidateAccessToken(token)
	if err != nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	// 3. Ban kontrolü — banlı kullanıcı WS bağlantısı kuramaz
	if h.banChecker != nil {
		banned, err := h.banChecker.IsBanned(r.Context(), claims.UserID)
		if err != nil {
			log.Printf("[ws] ban check failed for user %s: %v", claims.UserID, err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if banned {
			http.Error(w, "banned", http.StatusForbidden)
			return
		}
	}

	// 4. HTTP → WebSocket upgrade
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade failed for user %s: %v", claims.UserID, err)
		return
	}

	// 5. Client oluştur
	client := &Client{
		hub:    h.hub,
		conn:   conn,
		userID: claims.UserID,
		send:   make(chan []byte, sendBufferSize),
	}

	// Username cache'ini güncelle (typing broadcast için)
	h.hub.SetUserUsername(claims.UserID, claims.Username)

	// 6. Hub'a kaydet
	h.hub.register <- client

	// 7. "ready" event gönder — client bağlantı kurduğunda hangi kullanıcıların
	// online olduğunu bilmeli. Bu event ile frontend memberStore'u başlatır.
	client.sendEvent(Event{
		Op: OpReady,
		Data: ReadyData{
			OnlineUserIDs: h.hub.GetOnlineUserIDs(),
		},
	})

	// 7.5. "voice_states_sync" event gönder — bağlantı kurulduğunda hangi
	// kullanıcıların hangi ses kanallarında olduğunu client'a bildir.
	// Frontend voiceStore bu veri ile başlatılır.
	if h.voiceStatesProvider != nil {
		allStates := h.voiceStatesProvider.GetAllVoiceStates()
		// models.VoiceState → ws.VoiceStateItem dönüşümü
		items := make([]VoiceStateItem, len(allStates))
		for i, s := range allStates {
			items[i] = VoiceStateItem{
				UserID:      s.UserID,
				ChannelID:   s.ChannelID,
				Username:    s.Username,
				AvatarURL:   s.AvatarURL,
				IsMuted:     s.IsMuted,
				IsDeafened:  s.IsDeafened,
				IsStreaming: s.IsStreaming,
			}
		}
		client.sendEvent(Event{
			Op:   OpVoiceStatesSync,
			Data: VoiceStatesSyncData{States: items},
		})
	}

	// 8. Goroutine'leri başlat
	//
	// `go client.WritePump()` → yeni goroutine başlatır.
	// WritePump ayrı goroutine'de, ReadPump mevcut goroutine'de çalışır.
	// ReadPump mevcut goroutine'de çalışmalı — aksi halde bu fonksiyon hemen
	// döner ve HTTP handler sonlanır. ReadPump bağlantı kapanana kadar bloklar.
	go client.WritePump()
	client.ReadPump() // Bu satır bağlantı kapanana kadar bloklar
}
