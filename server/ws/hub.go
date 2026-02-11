package ws

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
)

// EventPublisher, service katmanının WebSocket event'leri broadcast etmek için
// kullandığı interface.
//
// Dependency Inversion: Service'ler Hub'ın concrete struct'ına değil,
// bu interface'e bağımlıdır. Böylece:
// 1. Service test edilirken mock EventPublisher kullanılabilir
// 2. Hub implementasyonu değişse bile service kodu etkilenmez
type EventPublisher interface {
	BroadcastToAll(event Event)
	BroadcastToAllExcept(excludeUserID string, event Event)
	BroadcastToUser(userID string, event Event)
	GetOnlineUserIDs() []string
}

// Hub, tüm WebSocket bağlantılarını yöneten merkezi yapıdır (Observer pattern).
//
// Observer pattern nedir?
// Bir "subject" (Hub) birden fazla "observer"ı (Client) takip eder.
// Bir event olduğunda Hub, tüm observer'lara bildirim gönderir.
// Discord'da mesaj gönderildiğinde tüm bağlı kullanıcılara iletilmesi bu pattern'dir.
//
// Go channel nedir? (register, unregister, broadcast)
// Goroutine'ler arası güvenli iletişim sağlayan yapılar.
// Hub.Run() goroutine'i bu channel'lardan `select` ile okur:
// - register channel'dan yeni client gelirse → clients map'e ekle
// - unregister channel'dan client gelirse → map'ten çıkar
// - broadcast channel'dan veri gelirse → tüm client'lara gönder
type Hub struct {
	// clients: userID → Client set (bir kullanıcının birden fazla tab'ı olabilir).
	// map[string]map[*Client]bool — Go'da set yoktur, map[*Client]bool kullanılır.
	// bool değeri her zaman true'dur — sadece varlık kontrolü için kullanılır.
	clients map[string]map[*Client]bool

	// mu: clients map'ini koruyan read-write mutex.
	//
	// sync.RWMutex nedir?
	// Mutex'in gelişmiş hali — birden fazla okuyucu aynı anda erişebilir (RLock),
	// ama yazma işlemi sırasında tüm erişim bloklanır (Lock).
	// Online kullanıcı listesi gibi okuma ağırlıklı işlemlerde performans sağlar.
	mu sync.RWMutex

	// register/unregister: Client giriş/çıkış sinyalleri.
	register   chan *Client
	unregister chan *Client

	// seq: Her outbound event'e verilen artan sayaç.
	// atomic.Int64: Birden fazla goroutine'in güvenle okuyup yazabildiği sayı.
	// Normal int64 kullanılsaydı race condition oluşurdu.
	seq atomic.Int64

	// usernames: userID → username cache (typing broadcast için).
	usernames map[string]string
	userMu    sync.RWMutex
}

// NewHub, yeni bir Hub oluşturur.
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]map[*Client]bool),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		usernames:  make(map[string]string),
	}
}

// Run, Hub'ın ana event loop'udur. main.go'da `go hub.Run()` ile başlatılır.
//
// goroutine olarak çalışır:
// `go hub.Run()` → yeni bir hafif "thread" (goroutine) başlatır.
// Go'da goroutine'ler OS thread'lerinden farklıdır — çok daha hafiftir (2KB stack).
// Yüz binlerce goroutine rahatça çalışabilir.
//
// select nedir?
// Birden fazla channel'ı aynı anda dinler.
// Hangi channel'dan veri gelirse o case çalışır.
// Hiçbirinden gelmezse bekler (blocking).
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.addClient(client)

		case client := <-h.unregister:
			h.removeClient(client)
		}
	}
}

// addClient, yeni bir client'ı Hub'a ekler.
func (h *Hub) addClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.clients[client.userID]; !ok {
		h.clients[client.userID] = make(map[*Client]bool)
	}
	h.clients[client.userID][client] = true

	log.Printf("[ws] client connected: user=%s (total connections for user: %d)",
		client.userID, len(h.clients[client.userID]))
}

// removeClient, bir client'ı Hub'dan çıkarır ve send channel'ını kapatır.
func (h *Hub) removeClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.clients[client.userID]; ok {
		if _, exists := clients[client]; exists {
			delete(clients, client)
			close(client.send)

			// Kullanıcının başka bağlantısı kalmadıysa map'ten sil
			if len(clients) == 0 {
				delete(h.clients, client.userID)
				log.Printf("[ws] user fully disconnected: %s", client.userID)
			} else {
				log.Printf("[ws] client disconnected: user=%s (remaining: %d)",
					client.userID, len(clients))
			}
		}
	}
}

// BroadcastToAll, tüm bağlı client'lara event gönderir.
func (h *Hub) BroadcastToAll(event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, clients := range h.clients {
		for client := range clients {
			select {
			case client.send <- data:
			default:
				// Buffer dolu — bu client yavaş, kapat
				go func(c *Client) { h.unregister <- c }(client)
			}
		}
	}
}

// BroadcastToAllExcept, belirli bir kullanıcı hariç tüm client'lara event gönderir.
// Typing indicator gibi durumlarda gönderen kişiye kendi typing event'i gitmez.
func (h *Hub) BroadcastToAllExcept(excludeUserID string, event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for userID, clients := range h.clients {
		if userID == excludeUserID {
			continue
		}
		for client := range clients {
			select {
			case client.send <- data:
			default:
				go func(c *Client) { h.unregister <- c }(client)
			}
		}
	}
}

// BroadcastToUser, belirli bir kullanıcının tüm bağlantılarına event gönderir.
func (h *Hub) BroadcastToUser(userID string, event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal user event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	if clients, ok := h.clients[userID]; ok {
		for client := range clients {
			select {
			case client.send <- data:
			default:
				go func(c *Client) { h.unregister <- c }(client)
			}
		}
	}
}

// GetOnlineUserIDs, bağlı olan tüm kullanıcı ID'lerini döner.
func (h *Hub) GetOnlineUserIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0, len(h.clients))
	for userID := range h.clients {
		ids = append(ids, userID)
	}
	return ids
}

// SetUserUsername, kullanıcı bağlandığında username cache'ini günceller.
func (h *Hub) SetUserUsername(userID, username string) {
	h.userMu.Lock()
	defer h.userMu.Unlock()
	h.usernames[userID] = username
}

// getUserUsername, userID'den username döner (typing broadcast için).
func (h *Hub) getUserUsername(userID string) string {
	h.userMu.RLock()
	defer h.userMu.RUnlock()
	return h.usernames[userID]
}

// Shutdown, tüm client bağlantılarını kapatır (graceful shutdown).
func (h *Hub) Shutdown() {
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, clients := range h.clients {
		for client := range clients {
			close(client.send)
		}
	}
	h.clients = make(map[string]map[*Client]bool)
	log.Println("[ws] hub shut down, all connections closed")
}
