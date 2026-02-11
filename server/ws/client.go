package ws

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocket bağlantı sabitleri
const (
	// writeWait: Bir mesajı yazmak için maksimum bekleme süresi.
	// Bu süre aşılırsa bağlantı kapatılır (ağ sorunu olabilir).
	writeWait = 10 * time.Second

	// pongWait: Client'ın heartbeat göndermesi için beklenen maksimum süre.
	// 3 heartbeat kaçırma = 30s × 3 = 90s.
	// Bu sürede heartbeat gelmezse client bağlantısı kopmuş sayılır.
	pongWait = 90 * time.Second

	// maxMessageSize: Client'ın gönderebileceği maksimum mesaj boyutu (byte).
	// WebSocket mesajları küçük olmalı — büyük veri HTTP ile gönderilir.
	maxMessageSize = 4096

	// sendBufferSize: Her client'ın send channel'ının buffer boyutu.
	// Buffer doluysa (client yavaş) mesajlar kaybolur — bu durumda client disconnect edilir.
	sendBufferSize = 256
)

// Client, tek bir WebSocket bağlantısını temsil eder.
//
// Go'da WebSocket bağlantı yönetimi pattern'i:
// Her bağlantı için iki goroutine oluşturulur:
// - ReadPump: Client'dan gelen mesajları okur → Hub'a iletir
// - WritePump: Hub'dan gelen mesajları client'a yazar
//
// Neden iki goroutine?
// gorilla/websocket aynı anda sadece bir okuma ve bir yazma işlemi destekler.
// İki ayrı goroutine kullanarak okuma ve yazma birbirini bloklamaz.
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	userID string
	// send, client'a gönderilecek mesajların buffer'landığı Go channel'ı.
	//
	// Go channel nedir?
	// Goroutine'ler arası veri iletimi için kullanılan tipli boru (pipe).
	// `make(chan []byte, 256)` → 256 elemanlık buffer'lı bir byte dizisi kanalı.
	// Hub mesaj göndermek istediğinde `client.send <- data` yapar,
	// WritePump `data := <-client.send` ile okur.
	send chan []byte
	mu   sync.Mutex // conn.WriteMessage çağrılarını korur
}

// ReadPump, WebSocket bağlantısından gelen mesajları okur ve işler.
//
// Bu fonksiyon bir goroutine olarak çalışır — bağlantı kapanana kadar döngüde kalır.
// Bağlantı kapandığında Hub'dan çıkış yapar ve kaynakları temizler.
func (c *Client) ReadPump() {
	// defer: Fonksiyon bittiğinde (return veya panic) çalışır.
	// Bağlantı kapandığında client'ı Hub'dan çıkar ve WS bağlantısını kapat.
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)

	// SetReadDeadline: Bu süre içinde mesaj gelmezse Read hata verir.
	// Her heartbeat geldiğinde deadline yenilenir.
	if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		log.Printf("[ws] failed to set read deadline for user %s: %v", c.userID, err)
		return
	}

	for {
		_, rawMessage, err := c.conn.ReadMessage()
		if err != nil {
			// Bağlantı kapandı veya hata oluştu — ReadPump sonlanır.
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[ws] unexpected close for user %s: %v", c.userID, err)
			}
			return
		}

		// Gelen mesajı parse et
		var event Event
		if err := json.Unmarshal(rawMessage, &event); err != nil {
			log.Printf("[ws] invalid message from user %s: %v", c.userID, err)
			continue
		}

		c.handleEvent(event)
	}
}

// handleEvent, client'dan gelen event'leri türüne göre işler.
func (c *Client) handleEvent(event Event) {
	switch event.Op {
	case OpHeartbeat:
		// Heartbeat geldi — deadline'ı yenile ve ack gönder.
		if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
			log.Printf("[ws] failed to set read deadline for user %s: %v", c.userID, err)
			return
		}
		c.sendEvent(Event{Op: OpHeartbeatAck})

	case OpTyping:
		// Typing event'ini parse et ve diğer kullanıcılara broadcast et.
		c.handleTyping(event)

	case OpPresenceUpdate:
		// Kullanıcı durumunu değiştirdi (idle, dnd vb.)
		c.handlePresenceUpdate(event)

	default:
		log.Printf("[ws] unknown op from user %s: %s", c.userID, event.Op)
	}
}

// handlePresenceUpdate, client'dan gelen presence değişikliğini işler.
//
// Client { op: "presence_update", d: { status: "idle" } } gönderdiğinde
// bu fonksiyon çağrılır ve tüm kullanıcılara broadcast edilir.
// Gerçek DB güncellemesi Hub callback'inde (main.go'da wire-up) yapılır.
func (c *Client) handlePresenceUpdate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data PresenceData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	// Geçerli status kontrolü
	switch data.Status {
	case "online", "idle", "dnd":
		// geçerli
	default:
		log.Printf("[ws] invalid presence status from user %s: %s", c.userID, data.Status)
		return
	}

	// Broadcast: presence_update event'ini tüm kullanıcılara gönder.
	// UserID'yi biz set ediyoruz — client'ın göndermesine güvenmeyiz (güvenlik).
	c.hub.BroadcastToAll(Event{
		Op: OpPresence,
		Data: PresenceData{
			UserID: c.userID,
			Status: data.Status,
		},
	})
}

// handleTyping, typing event'ini işler ve diğer kullanıcılara broadcast eder.
func (c *Client) handleTyping(event Event) {
	// Event data'sını JSON'dan TypingData'ya parse et.
	//
	// json.Marshal + json.Unmarshal neden?
	// event.Data tipi `any` (interface{}), doğrudan cast edemeyiz.
	// JSON'a çevirip tekrar parse etmek en güvenli yöntem.
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var typing TypingData
	if err := json.Unmarshal(dataBytes, &typing); err != nil {
		return
	}

	if typing.ChannelID == "" {
		return
	}

	// Broadcast: typing_start event'ini tüm kullanıcılara gönder (gönderen hariç).
	c.hub.BroadcastToAllExcept(c.userID, Event{
		Op: OpTypingStart,
		Data: TypingStartData{
			UserID:    c.userID,
			Username:  c.hub.getUserUsername(c.userID),
			ChannelID: typing.ChannelID,
		},
	})
}

// sendEvent, client'a tek bir event gönderir.
func (c *Client) sendEvent(event Event) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal event for user %s: %v", c.userID, err)
		return
	}

	select {
	case c.send <- data:
		// Başarıyla buffer'a eklendi
	default:
		// Buffer dolu — client muhtemelen donmuş, bağlantıyı kapat
		log.Printf("[ws] send buffer full for user %s, dropping connection", c.userID)
		c.hub.unregister <- c
	}
}

// WritePump, Hub'dan gelen mesajları WebSocket bağlantısına yazar.
//
// Bu fonksiyon bir goroutine olarak çalışır.
// send channel'dan mesaj bekler ve WS'e yazar.
func (c *Client) WritePump() {
	defer c.conn.Close()

	for {
		message, ok := <-c.send
		if !ok {
			// Channel kapatıldı — Hub client'ı çıkardı
			c.writeMessage(websocket.CloseMessage, nil)
			return
		}

		if err := c.writeMessage(websocket.TextMessage, message); err != nil {
			return
		}
	}
}

// writeMessage, WebSocket'e mesaj yazar (mutex ile korunur).
//
// sync.Mutex nedir?
// Aynı anda sadece bir goroutine'in kritik bölgeye girmesini sağlar.
// c.mu.Lock() → bölgeye gir, c.mu.Unlock() → bölgeden çık.
// gorilla/websocket conn'a aynı anda birden fazla yazma YASAK —
// bu yüzden mutex ile koruyoruz.
func (c *Client) writeMessage(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		return err
	}
	return c.conn.WriteMessage(messageType, data)
}
