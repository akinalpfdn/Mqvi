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

// UserInfoProvider, kullanıcı bilgilerini DB'den sorgulayan interface (ISP).
//
// UserRepository'nin GetByID metodunu karşılar (Go implicit interface).
// WS bağlantısı kurulduğunda kullanıcının display_name ve avatar_url
// bilgilerini Hub cache'ine yazmak için kullanılır.
// JWT claims sadece userID + username içerir — profil verileri DB'den çekilir.
type UserInfoProvider interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

// ServerListProvider, kullanıcının üye olduğu sunucu listesini dönen interface (ISP).
//
// ServerRepository'nin GetUserServers metodunu karşılar (Go implicit interface).
// WS bağlantısı kurulduğunda ready event'e sunucu listesi eklenir ve
// client.serverIDs doldurulur (BroadcastToServer filtrelemesi için).
type ServerListProvider interface {
	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)
}

// MuteChecker, kullanıcının sessize aldığı sunucuları sorgulayan interface (ISP).
//
// ServerMuteService'in GetMutedServerIDs metodunu karşılar (Go implicit interface).
// WS bağlantısı kurulduğunda ready event'e muted sunucu ID'leri eklenir.
// Frontend bu bilgiyle muted sunuculardaki bildirimleri bastırır.
type MuteChecker interface {
	GetMutedServerIDs(ctx context.Context, userID string) ([]string, error)
}

// ChannelMuteChecker, kullanıcının sessize aldığı kanalları sorgulayan interface (ISP).
//
// ChannelMuteService'in GetMutedChannelIDs metodunu karşılar (Go implicit interface).
// WS bağlantısı kurulduğunda ready event'e muted kanal ID'leri eklenir.
type ChannelMuteChecker interface {
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
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
	userInfoProvider    UserInfoProvider
	serverListProvider  ServerListProvider
	muteChecker         MuteChecker
	channelMuteChecker  ChannelMuteChecker
}

// NewHandler, yeni bir WebSocket handler oluşturur.
//
// tokenValidator: JWT token doğrulaması (pratikte authService).
// banChecker: Banlı kullanıcı kontrolü — multi-server'da nil geçilir (ban sunucu bazlı).
// voiceStatesProvider: Aktif voice state'leri (pratikte voiceService).
// userInfoProvider: Kullanıcı profil bilgileri (pratikte userRepo).
// serverListProvider: Kullanıcının sunucu listesi (pratikte serverRepo).
// muteChecker: Kullanıcının mute'lu sunucu ID'leri (pratikte serverMuteService).
// channelMuteChecker: Kullanıcının mute'lu kanal ID'leri (pratikte channelMuteService).
func NewHandler(
	hub *Hub,
	tokenValidator TokenValidator,
	banChecker BanChecker,
	voiceStatesProvider VoiceStatesProvider,
	userInfoProvider UserInfoProvider,
	serverListProvider ServerListProvider,
	muteChecker MuteChecker,
	channelMuteChecker ChannelMuteChecker,
) *Handler {
	return &Handler{
		hub:                 hub,
		tokenValidator:      tokenValidator,
		banChecker:          banChecker,
		voiceStatesProvider: voiceStatesProvider,
		userInfoProvider:    userInfoProvider,
		serverListProvider:  serverListProvider,
		muteChecker:         muteChecker,
		channelMuteChecker:  channelMuteChecker,
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

	// 3. User bilgilerini DB'den çek (ban kontrolleri + hub cache için).
	// WS upgrade'den ÖNCE yapılır — banlı kullanıcıya upgrade verilmez.
	// display_name ve avatar_url JWT claims'te bulunmaz — DB lookup gerekir.
	var displayName, avatarURL string
	var dbStatus models.UserStatus
	if h.userInfoProvider != nil {
		user, err := h.userInfoProvider.GetByID(r.Context(), claims.UserID)
		if err != nil {
			log.Printf("[ws] user info fetch failed for %s: %v", claims.UserID, err)
			http.Error(w, "user not found", http.StatusUnauthorized)
			return
		}
		// Platform-level ban — tüm WS bağlantılarını bloklar
		if user.IsPlatformBanned {
			http.Error(w, "account suspended", http.StatusForbidden)
			return
		}
		if user.DisplayName != nil {
			displayName = *user.DisplayName
		}
		if user.AvatarURL != nil {
			avatarURL = *user.AvatarURL
		}
		dbStatus = user.Status
	}

	// 4. Server-scoped ban kontrolü — banlı kullanıcı WS bağlantısı kuramaz
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

	// 5. HTTP → WebSocket upgrade
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade failed for user %s: %v", claims.UserID, err)
		return
	}

	// 6. Client oluştur
	// pref_status: Client'ın WS bağlanırken gönderdiği tercih edilen presence durumu.
	// localStorage'daki manualStatus değeri (online/idle/dnd/offline).
	// OnUserFirstConnect callback'ine geçirilerek reconnect sonrası doğru status
	// anında broadcast edilir — "online" geçici flash'ı olmadan.
	prefStatus := r.URL.Query().Get("pref_status")
	switch prefStatus {
	case "online", "idle", "dnd", "offline":
		// geçerli
	default:
		// bilinmeyen değer — DB status'a göre belirle
		prefStatus = ""
	}

	client := &Client{
		hub:        h.hub,
		conn:       conn,
		userID:     claims.UserID,
		send:       make(chan []byte, sendBufferSize),
		prefStatus: prefStatus,
	}
	h.hub.SetUserInfo(claims.UserID, claims.Username, displayName, avatarURL)

	// Invisible tracking: Kullanıcı "offline" (invisible) modunda bağlanıyorsa
	// Hub'a kayıt OLMADAN ÖNCE invisible olarak işaretle.
	// Bu sayede ready event'teki GetVisibleOnlineUserIDs() doğru çalışır.
	//
	// Öncelik sırası: pref_status (client'ın en güncel tercihi) > DB status (eski)
	// DB status "offline" kalabilir çünkü OnUserFullyDisconnected bunu set eder.
	isInvisible := prefStatus == "offline"
	if prefStatus == "" {
		// pref_status gönderilmemişse (eski client veya edge case) DB'ye bak
		isInvisible = dbStatus == models.UserStatusOffline
	}
	if isInvisible {
		h.hub.SetInvisible(claims.UserID, true)
	}

	// 6. Sunucu listesini al ve client.serverIDs'i doldur
	//
	// Multi-server: bağlantı kurulduğunda kullanıcının üye olduğu sunucuları
	// DB'den çek. İki amaçla kullanılır:
	// 1. Ready event'te sunucu listesini frontend'e gönder
	// 2. client.serverIDs'i doldur — BroadcastToServer filtrelemesi için
	var readyServers []ReadyServerItem
	var serverIDs []string
	if h.serverListProvider != nil {
		if servers, err := h.serverListProvider.GetUserServers(r.Context(), claims.UserID); err == nil {
			readyServers = make([]ReadyServerItem, len(servers))
			serverIDs = make([]string, len(servers))
			for i, s := range servers {
				readyServers[i] = ReadyServerItem{
					ID:      s.ID,
					Name:    s.Name,
					IconURL: s.IconURL,
				}
				serverIDs[i] = s.ID
			}
		}
	}
	client.serverIDs = serverIDs

	// 6.5. Kullanıcının mute'lu sunucu ID'lerini al
	//
	// Ready event'e eklenir — frontend bu bilgiyle muted sunuculardan
	// gelen bildirimleri (unread badge, ses, flash) bastırır.
	var mutedServerIDs []string
	if h.muteChecker != nil {
		if ids, err := h.muteChecker.GetMutedServerIDs(r.Context(), claims.UserID); err == nil {
			mutedServerIDs = ids
		} else {
			log.Printf("[ws] mute check failed for user %s: %v", claims.UserID, err)
		}
	}
	if mutedServerIDs == nil {
		mutedServerIDs = []string{}
	}

	// 6.6. Kullanıcının mute'lu kanal ID'lerini al
	//
	// Ready event'e eklenir — frontend bu bilgiyle muted kanallardan
	// gelen bildirimleri (unread badge, ses, flash) bastırır.
	var mutedChannelIDs []string
	if h.channelMuteChecker != nil {
		if ids, err := h.channelMuteChecker.GetMutedChannelIDs(r.Context(), claims.UserID); err == nil {
			mutedChannelIDs = ids
		} else {
			log.Printf("[ws] channel mute check failed for user %s: %v", claims.UserID, err)
		}
	}
	if mutedChannelIDs == nil {
		mutedChannelIDs = []string{}
	}

	// 7. Hub'a kaydet
	h.hub.register <- client

	// 8. "ready" event gönder — client bağlantı kurduğunda:
	// - Hangi sunuculara üye olduğunu bilmeli (server list sidebar)
	// - Hangi kullanıcıların online olduğunu bilmeli (presence indicator)
	// - Hangi sunucuları sessize aldığını bilmeli (mute suppression)
	//
	// GetVisibleOnlineUserIDs() invisible kullanıcıları hariç tutar —
	// "offline" status seçmiş ama bağlı olan kullanıcılar listede görünmez.
	client.sendEvent(Event{
		Op: OpReady,
		Data: ReadyData{
			OnlineUserIDs:   h.hub.GetVisibleOnlineUserIDs(),
			Servers:         readyServers,
			MutedServerIDs:  mutedServerIDs,
			MutedChannelIDs: mutedChannelIDs,
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
				UserID:           s.UserID,
				ChannelID:        s.ChannelID,
				Username:         s.Username,
				DisplayName:      s.DisplayName,
				AvatarURL:        s.AvatarURL,
				IsMuted:          s.IsMuted,
				IsDeafened:       s.IsDeafened,
				IsStreaming:      s.IsStreaming,
				IsServerMuted:    s.IsServerMuted,
				IsServerDeafened: s.IsServerDeafened,
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
