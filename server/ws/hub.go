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
	DisconnectUser(userID string)
}

// UserConnectionCallback, bir kullanıcının bağlantı durumu değiştiğinde çağrılır.
//
// Bu callback pattern nedir?
// Hub, bağlantı olaylarında (ilk bağlantı, tam kopuş) dış katmanlara
// haber vermek için fonksiyon referansı tutar. main.go'da set edilir.
// Böylece Hub doğrudan service'e bağımlı olmaz (Dependency Inversion).
type UserConnectionCallback func(userID string)

// ─── Voice Callback Tipleri ───
//
// Voice event'leri de aynı callback pattern'ini kullanır.
// Client ses kanalına katılmak/ayrılmak/state güncellemek istediğinde
// Hub bu callback'leri tetikler. main.go'da voiceService'e wire-up yapılır.

// VoiceJoinCallback, kullanıcı ses kanalına katılmak istediğinde çağrılır.
type VoiceJoinCallback func(userID, username, avatarURL, channelID string)

// VoiceLeaveCallback, kullanıcı ses kanalından ayrılmak istediğinde çağrılır.
type VoiceLeaveCallback func(userID string)

// VoiceStateUpdateCallback, kullanıcı mute/deafen/stream toggle'ladığında çağrılır.
// Pointer parametreler: nil = o alan değişmiyor (partial update).
type VoiceStateUpdateCallback func(userID string, isMuted, isDeafened, isStreaming *bool)

// PresenceManualUpdateCallback, kullanıcı presence durumunu manuel değiştirdiğinde çağrılır.
// Idle detection veya DND toggle gibi client-initiated durum değişikliklerinde tetiklenir.
// main.go'da wire-up yapılır — DB persist + broadcast bu callback'te gerçekleşir.
type PresenceManualUpdateCallback func(userID string, status string)

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

	// Presence callback'leri — main.go'da set edilir.
	// Hub bağlantı olaylarında bu fonksiyonları çağırır.
	// Callback'ler ayrı goroutine'de çalıştırılır (deadlock önleme).
	//
	// Neden goroutine? addClient/removeClient h.mu.Lock() tutar.
	// Callback içinde BroadcastToAll çağrılırsa h.mu.RLock() ister → deadlock!
	// go func() ile ayrı goroutine'de çalıştırmak Lock'u serbest bıraktıktan
	// sonra callback'in çalışmasını sağlar.
	onUserFirstConnect      UserConnectionCallback
	onUserFullyDisconnected UserConnectionCallback

	// Voice callback'leri — main.go'da set edilir.
	// Client voice event gönderdiğinde handleEvent → Hub callback → main.go → VoiceService
	onVoiceJoin        VoiceJoinCallback
	onVoiceLeave       VoiceLeaveCallback
	onVoiceStateUpdate VoiceStateUpdateCallback

	// Presence manuel güncelleme callback'i — main.go'da set edilir.
	// Client idle/dnd gibi durum değişikliği gönderdiğinde DB persist için çağrılır.
	onPresenceManualUpdate PresenceManualUpdateCallback
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
// Kullanıcının ilk bağlantısıysa onUserFirstConnect callback'ini tetikler.
func (h *Hub) addClient(client *Client) {
	h.mu.Lock()

	isFirstConnection := len(h.clients[client.userID]) == 0
	if _, ok := h.clients[client.userID]; !ok {
		h.clients[client.userID] = make(map[*Client]bool)
	}
	h.clients[client.userID][client] = true

	log.Printf("[ws] client connected: user=%s (total connections for user: %d)",
		client.userID, len(h.clients[client.userID]))

	h.mu.Unlock()

	// Callback'i Lock dışında, ayrı goroutine'de çağır (deadlock önleme).
	if isFirstConnection && h.onUserFirstConnect != nil {
		userID := client.userID
		go h.onUserFirstConnect(userID)
	}
}

// removeClient, bir client'ı Hub'dan çıkarır ve send channel'ını kapatır.
// Kullanıcının son bağlantısı kapandıysa onUserFullyDisconnected callback'ini tetikler.
func (h *Hub) removeClient(client *Client) {
	h.mu.Lock()

	var fullyDisconnected bool
	var userID string

	if clients, ok := h.clients[client.userID]; ok {
		if _, exists := clients[client]; exists {
			delete(clients, client)
			close(client.send)

			if len(clients) == 0 {
				delete(h.clients, client.userID)
				fullyDisconnected = true
				userID = client.userID
				log.Printf("[ws] user fully disconnected: %s", client.userID)
			} else {
				log.Printf("[ws] client disconnected: user=%s (remaining: %d)",
					client.userID, len(clients))
			}
		}
	}

	h.mu.Unlock()

	// Callback'i Lock dışında, ayrı goroutine'de çağır (deadlock önleme).
	if fullyDisconnected && h.onUserFullyDisconnected != nil {
		go h.onUserFullyDisconnected(userID)
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

// OnUserFirstConnect, kullanıcının ilk bağlantısında çağrılacak callback'i ayarlar.
//
// "İlk bağlantı" = kullanıcının daha önce hiç aktif bağlantısı yoktu, şimdi var.
// Aynı kullanıcının 2. tab'ı açarsa bu callback tekrar çağrılMAZ.
func (h *Hub) OnUserFirstConnect(cb UserConnectionCallback) {
	h.onUserFirstConnect = cb
}

// OnUserFullyDisconnected, kullanıcının tüm bağlantıları kapandığında çağrılacak callback'i ayarlar.
//
// "Tam kopuş" = kullanıcının son tab'ı da kapandı, artık hiç bağlantısı yok.
// 3 tab açıkken 2'sini kapatmak bu callback'i tetikleMEZ.
func (h *Hub) OnUserFullyDisconnected(cb UserConnectionCallback) {
	h.onUserFullyDisconnected = cb
}

// OnPresenceManualUpdate, kullanıcı presence durumunu manuel değiştirdiğinde
// çağrılacak callback'i ayarlar (idle detection, DND toggle vb.).
//
// Bu callback DB persist + broadcast işlemlerini yapar.
// handlePresenceUpdate'teki eski broadcast kodu kaldırıldı —
// tüm sorumluluk bu callback'e devredildi.
func (h *Hub) OnPresenceManualUpdate(cb PresenceManualUpdateCallback) {
	h.onPresenceManualUpdate = cb
}

// OnVoiceJoin, kullanıcı ses kanalına katılmak istediğinde çağrılacak callback'i ayarlar.
func (h *Hub) OnVoiceJoin(cb VoiceJoinCallback) {
	h.onVoiceJoin = cb
}

// OnVoiceLeave, kullanıcı ses kanalından ayrılmak istediğinde çağrılacak callback'i ayarlar.
func (h *Hub) OnVoiceLeave(cb VoiceLeaveCallback) {
	h.onVoiceLeave = cb
}

// OnVoiceStateUpdate, kullanıcı mute/deafen/stream toggle'ladığında çağrılacak callback'i ayarlar.
func (h *Hub) OnVoiceStateUpdate(cb VoiceStateUpdateCallback) {
	h.onVoiceStateUpdate = cb
}

// DisconnectUser, bir kullanıcının tüm WebSocket bağlantılarını kapatır.
//
// Kullanım: Ban işlemi sonrasında kullanıcıyı zorla çıkarmak için.
// RLock ile client listesini okur, sonra her client'ı unregister kuyruğuna gönderir.
func (h *Hub) DisconnectUser(userID string) {
	h.mu.RLock()
	clients := make([]*Client, 0)
	if userClients, ok := h.clients[userID]; ok {
		for client := range userClients {
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range clients {
		h.unregister <- client
	}
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
