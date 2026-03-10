package ws

import (
	"context"
	"log"
	"net/http"
	"net/url"

	"github.com/gorilla/websocket"

	"github.com/akinalp/mqvi/models"
)

// TokenValidator validates JWT tokens for WS connections.
// Defined here (not importing services.AuthService) to avoid circular dependency.
type TokenValidator interface {
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)
}

// BanChecker checks if a user is banned. Avoids circular ws -> services dependency.
type BanChecker interface {
	IsBanned(ctx context.Context, userID string) (bool, error)
}

// VoiceStatesProvider returns all active voice states for the ready event.
type VoiceStatesProvider interface {
	GetAllVoiceStates() []models.VoiceState
}

// UserInfoProvider fetches user profile from DB for Hub cache.
// JWT claims only contain userID + username; display_name/avatar_url need DB lookup.
type UserInfoProvider interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

// ServerListProvider returns the user's server list for the ready event and
// client.serverIDs (BroadcastToServer filtering).
type ServerListProvider interface {
	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)
}

// MuteChecker returns muted server IDs for the ready event.
type MuteChecker interface {
	GetMutedServerIDs(ctx context.Context, userID string) ([]string, error)
}

// ChannelMuteChecker returns muted channel IDs for the ready event.
type ChannelMuteChecker interface {
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}

// AppLogger writes structured app logs asynchronously. ISP interface to avoid circular dependency.
type AppLogger interface {
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

// AllowedOrigins is set by main.go at startup to share the same origin
// whitelist between HTTP CORS and WebSocket upgrade.
// Electron production uses file:// protocol which sends "null" as Origin.
var AllowedOrigins []string

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		// No Origin header = same-origin request (non-browser or same host)
		if origin == "" {
			return true
		}
		// Electron file:// sends "null" as Origin
		if origin == "null" {
			return true
		}
		// Same-origin: origin host matches request Host header
		if u, err := url.Parse(origin); err == nil && u.Host == r.Host {
			return true
		}
		for _, allowed := range AllowedOrigins {
			if origin == allowed {
				return true
			}
		}
		log.Printf("[ws] rejected connection from origin: %s", origin)
		return false
	},
}

// Handler handles WebSocket connection upgrades.
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

// HandleConnection upgrades HTTP to WebSocket, validates auth, and starts the client.
// Token is passed as a query param (?token=JWT) since browsers can't set
// custom headers on WebSocket handshakes.
func (h *Handler) HandleConnection(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}

	claims, err := h.tokenValidator.ValidateAccessToken(token)
	if err != nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	// Fetch user info before upgrade — reject banned users early
	var displayName, avatarURL string
	var dbStatus models.UserStatus
	if h.userInfoProvider != nil {
		user, err := h.userInfoProvider.GetByID(r.Context(), claims.UserID)
		if err != nil {
			log.Printf("[ws] user info fetch failed for %s: %v", claims.UserID, err)
			http.Error(w, "user not found", http.StatusUnauthorized)
			return
		}
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

	// Server-scoped ban check
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

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade failed for user %s: %v", claims.UserID, err)
		return
	}

	// pref_status from client localStorage — correct status broadcast on reconnect
	prefStatus := r.URL.Query().Get("pref_status")
	switch prefStatus {
	case "online", "idle", "dnd", "offline":
		// valid
	default:
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

	// Set invisible BEFORE register so GetVisibleOnlineUserIDs is correct in the ready event.
	// Priority: pref_status (latest client preference) > DB status (possibly stale)
	isInvisible := prefStatus == "offline"
	if prefStatus == "" {
		isInvisible = dbStatus == models.UserStatusOffline
	}
	if isInvisible {
		h.hub.SetInvisible(claims.UserID, true)
	}

	// Load user's server list for ready event + BroadcastToServer filtering
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

	// Muted server IDs for notification suppression
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

	// Muted channel IDs for notification suppression
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

	h.hub.register <- client

	// Send ready event with online users, servers, and mute state
	client.sendEvent(Event{
		Op: OpReady,
		Data: ReadyData{
			OnlineUserIDs:   h.hub.GetVisibleOnlineUserIDs(),
			Servers:         readyServers,
			MutedServerIDs:  mutedServerIDs,
			MutedChannelIDs: mutedChannelIDs,
		},
	})

	// Send voice states sync so frontend can initialize voiceStore
	if h.voiceStatesProvider != nil {
		allStates := h.voiceStatesProvider.GetAllVoiceStates()
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

	// Start pumps — WritePump in goroutine, ReadPump blocks until disconnect
	go client.WritePump()
	client.ReadPump()
}
