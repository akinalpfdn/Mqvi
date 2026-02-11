package ws

import (
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
	hub            *Hub
	tokenValidator TokenValidator
}

// NewHandler, yeni bir WebSocket handler oluşturur.
//
// tokenValidator parametresi TokenValidator interface'ini karşılayan herhangi bir
// struct olabilir. Pratikte bu authService'dir — Go'da interface'ler implicit'tir,
// yani authService.ValidateAccessToken metodu varsa otomatik olarak karşılar.
func NewHandler(hub *Hub, tokenValidator TokenValidator) *Handler {
	return &Handler{
		hub:            hub,
		tokenValidator: tokenValidator,
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
// 3. HTTP → WebSocket upgrade
// 4. Client oluştur, Hub'a kaydet
// 5. ReadPump ve WritePump goroutine'lerini başlat
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

	// 3. HTTP → WebSocket upgrade
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade failed for user %s: %v", claims.UserID, err)
		return
	}

	// 4. Client oluştur
	client := &Client{
		hub:    h.hub,
		conn:   conn,
		userID: claims.UserID,
		send:   make(chan []byte, sendBufferSize),
	}

	// Username cache'ini güncelle (typing broadcast için)
	h.hub.SetUserUsername(claims.UserID, claims.Username)

	// 5. Hub'a kaydet
	h.hub.register <- client

	// 6. Goroutine'leri başlat
	//
	// `go client.WritePump()` → yeni goroutine başlatır.
	// WritePump ayrı goroutine'de, ReadPump mevcut goroutine'de çalışır.
	// ReadPump mevcut goroutine'de çalışmalı — aksi halde bu fonksiyon hemen
	// döner ve HTTP handler sonlanır. ReadPump bağlantı kapanana kadar bloklar.
	go client.WritePump()
	client.ReadPump() // Bu satır bağlantı kapanana kadar bloklar
}
