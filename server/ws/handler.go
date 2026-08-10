package ws

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ratelimit"
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
	GetActiveChannelTimers() map[string]int64
}

// IncomingCallProvider returns a pending RINGING incoming-call payload for a user,
// re-delivered on (re)connect so a receiver who missed the live event (offline, or
// just tapped a push) still gets the incoming-call overlay.
type IncomingCallProvider interface {
	PendingIncomingCall(userID string) *models.P2PCallBroadcast
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

// PresencePeerProvider returns the users entitled to this user's presence who may share no server
// with them — friends and DM partners. Loaded once per connection; the hub cannot derive it.
type PresencePeerProvider interface {
	ListPresencePeerIDs(ctx context.Context, userID string) ([]string, error)
}

// MuteChecker returns muted server IDs for the ready event.
type MuteChecker interface {
	GetMutedServerIDs(ctx context.Context, userID string) ([]string, error)
}

// ChannelMuteChecker returns muted channel IDs for the ready event.
type ChannelMuteChecker interface {
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}

// URLSigner signs file URLs before they reach the client.
// ISP interface to avoid circular ws -> services dependency.
type URLSigner interface {
	SignURL(fileURL string) string
	SignURLPtr(fileURL *string) *string
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
		log.Printf("[ws] CheckOrigin called — origin=%q host=%q", origin, r.Host)
		// No Origin header = same-origin request (non-browser or same host)
		if origin == "" {
			return true
		}
		// Electron sends "file://" or "null" as Origin depending on version
		if origin == "null" || origin == "file://" {
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
	hub                  *Hub
	tokenValidator       TokenValidator
	banChecker           BanChecker
	voiceStatesProvider  VoiceStatesProvider
	userInfoProvider     UserInfoProvider
	serverListProvider   ServerListProvider
	muteChecker          MuteChecker
	channelMuteChecker   ChannelMuteChecker
	urlSigner            URLSigner
	presencePeers        PresencePeerProvider
	incomingCallProvider IncomingCallProvider

	// Handshake rate limit. Nil means unlimited, which is what the tests and any caller that has
	// not wired it get. The concurrent-socket cap lives on the hub — see SetConnectionLimits.
	connectLimiter *ratelimit.LoginRateLimiter
}

// SetConnectionLimits wires the door limits post-construction, keeping config out of the ws
// package's constructor signature. connectsPerMinute or maxConnections <= 0 disables that limit.
func (h *Handler) SetConnectionLimits(maxConnections, connectsPerMinute int) {
	// The cap is enforced by the hub, under the lock that registers a client — the handler only
	// gets a cheap pre-upgrade look at it.
	h.hub.SetMaxConnectionsPerUser(maxConnections)
	// Replacing a limiter would otherwise orphan its cleanup goroutine and silently hand everyone
	// a fresh budget. Called once today; this keeps a second call from being a quiet leak.
	if h.connectLimiter != nil {
		h.connectLimiter.Stop()
		h.connectLimiter = nil
	}
	if connectsPerMinute > 0 {
		// Keyed by user id, not IP. The limiter is a generic string-keyed window; the type name is
		// historical. Per-user is the right key here: a shared NAT would otherwise let one office
		// exhaust the budget for everyone behind it, and the cost being bounded — handshake DB work
		// — is charged to an account regardless of where it came from.
		h.connectLimiter = ratelimit.NewLoginRateLimiter(connectsPerMinute, time.Minute)
	}
}

// SetPresencePeerProvider wires the friend/DM peer source post-construction, keeping the
// ws -> repository dependency out of the constructor signature.
func (h *Handler) SetPresencePeerProvider(p PresencePeerProvider) {
	h.presencePeers = p
}

// SetIncomingCallProvider wires the (optional) provider used to re-deliver a ringing
// incoming call on connect. Set post-construction to avoid a ws->services dependency.
func (h *Handler) SetIncomingCallProvider(p IncomingCallProvider) {
	h.incomingCallProvider = p
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
	urlSigner URLSigner,
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
		urlSigner:           urlSigner,
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
		h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, nil, "WS connect: invalid token", map[string]string{
			"error": err.Error(),
		})
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	// Both door checks sit here: after the token is verified (so the key is a real user and not
	// something a stranger picked) and before the first DB query. A handshake costs six of them
	// plus the ready marshal, so an unthrottled connect loop is a database amplifier — throttling
	// it after paying that cost would not be throttling.
	if h.connectLimiter != nil && !h.connectLimiter.Allow(claims.UserID) {
		h.hub.RefusedTooFast()
		w.Header().Set("Retry-After", strconv.Itoa(h.connectLimiter.RetryAfterSeconds(claims.UserID)))
		http.Error(w, "too many connection attempts", http.StatusTooManyRequests)
		return
	}

	// Every open socket carries its own inbound event budget, so N sockets is N times the rate the
	// per-connection limiter was set to allow. This refuses the ordinary over-cap connect early and
	// politely; Hub.addClient is where the cap is actually enforced, under the registration lock.
	//
	// Reject the newcomer rather than evict the oldest. Evicting reads as friendlier to a
	// multi-device user, but the evicted client reconnects — and that connect evicts the next
	// oldest, and so on: a benign situation (someone with too many tabs) turns into a churn loop
	// paying six DB queries a cycle until the limiter above cuts it off, by which point several of
	// their tabs are broken instead of one. Rejecting fails once, cleanly, and leaves the working
	// connections alone.
	//
	// The cost of that choice: a socket whose peer vanished holds its slot until ReadPump gives up,
	// up to pongWait (90s). Locking a user out would take maxConnections deaths inside that window,
	// which is not a shape real networks produce — and the cap is configurable if it ever is.
	if h.hub.AtConnectionLimit(claims.UserID) {
		h.hub.RefusedOverCap()
		http.Error(w, "too many open connections", http.StatusTooManyRequests)
		return
	}

	// Fetch user info before upgrade — reject banned users early
	var displayName, avatarURL string
	var dbPrefStatus models.UserStatus
	if h.userInfoProvider != nil {
		user, err := h.userInfoProvider.GetByID(r.Context(), claims.UserID)
		if err != nil {
			log.Printf("[ws] user info fetch failed for %s: %v", claims.UserID, err)
			h.hub.logEvent(models.LogLevelError, models.LogCategoryWS, &claims.UserID, "WS connect: user lookup failed", map[string]string{
				"error": err.Error(),
			})
			http.Error(w, "user not found", http.StatusUnauthorized)
			return
		}
		if user.IsPlatformBanned {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, &claims.UserID, "WS connect blocked: account suspended", nil)
			http.Error(w, "account suspended", http.StatusForbidden)
			return
		}
		// Reject deleted/tombstone accounts — existing JWTs cannot keep WS open after delete.
		if user.DeletedAt != nil {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, &claims.UserID, "WS connect blocked: account deleted", nil)
			http.Error(w, "account deleted", http.StatusUnauthorized)
			return
		}
		// Token revocation (password change, force-logout): reject tokens with stale tv.
		if claims.TokenVersion != user.TokenVersion {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, &claims.UserID, "WS connect blocked: token revoked", nil)
			http.Error(w, "token revoked", http.StatusUnauthorized)
			return
		}
		if user.DisplayName != nil {
			displayName = *user.DisplayName
		}
		if user.AvatarURL != nil {
			avatarURL = *user.AvatarURL
		}
		dbPrefStatus = user.PrefStatus
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

	// pref_status from DB — persistent across devices and sessions
	prefStatus := string(dbPrefStatus)
	if prefStatus == "" {
		prefStatus = "online"
	}

	// Same id the device registers its push token under, so the two can be matched. Empty for
	// clients that predate the device chain; the server then addresses the whole user.
	deviceID := r.URL.Query().Get("device_id")
	if len(deviceID) > 64 {
		deviceID = ""
	}

	client := &Client{
		hub:           h.hub,
		conn:          conn,
		userID:        claims.UserID,
		sessionID:     uuid.New().String(),
		deviceID:      deviceID,
		send:          make(chan []byte, sendBufferSize),
		events:        make(chan Event, eventQueueSize),
		done:          make(chan struct{}),
		prefStatus:    prefStatus,
		eventLimiter:  ratelimit.NewTokenBucket(eventBurst, eventRefillPerSec),
		signalLimiter: ratelimit.NewTokenBucket(signalBurst, signalRefillPerSec),
	}
	h.hub.SetUserInfo(claims.UserID, claims.Username, displayName, avatarURL)

	// Set invisible BEFORE the ready payload is built: GetVisibleAudienceFor filters invisible
	// users, so a late SetInvisible would list this user as online to everyone in their audience.
	isInvisible := prefStatus == "offline"
	if isInvisible {
		h.hub.SetInvisible(claims.UserID, true)
	}

	// Load user's server list for ready event + BroadcastToServer filtering
	var readyServers []models.ServerListItem
	var serverIDs []string
	if h.serverListProvider != nil {
		if servers, err := h.serverListProvider.GetUserServers(r.Context(), claims.UserID); err == nil {
			readyServers = make([]models.ServerListItem, len(servers))
			serverIDs = make([]string, len(servers))
			for i, s := range servers {
				// Copy, then replace only the URL — listing fields by hand is what dropped
				// `verified` and `e2ee_enabled` here for as long as this event has existed.
				item := s
				item.IconURL = h.urlSigner.SignURLPtr(s.IconURL)
				readyServers[i] = item
				serverIDs[i] = s.ID
			}
		}
	}
	client.serverIDs = serverIDs

	// Friends and DM partners: entitled to this user's presence with or without a shared server.
	// Once per connection, so the presence path itself stays free of the database.
	//
	// Kept in a local as well as on the Client: once this connection is registered, AddPresencePeer
	// may append to client.presencePeerIDs under the hub lock, and the ready payload below reads it
	// without one. Reading the field there would be an unsynchronised read of a slice header while
	// another goroutine grows it.
	var presencePeers []string
	if h.presencePeers != nil {
		if peers, err := h.presencePeers.ListPresencePeerIDs(r.Context(), claims.UserID); err == nil {
			presencePeers = peers
			client.presencePeerIDs = peers
		} else {
			// Degrade to server-scoped presence rather than refusing the connection.
			log.Printf("[ws] presence peer load failed for %s: %v", claims.UserID, err)
		}
	}

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

	// Send ready event with online users, servers, mute state, and persisted pref_status
	client.sendEvent(Event{
		Op: OpReady,
		Data: ReadyData{
			SessionID:       client.sessionID,
			OnlineUserIDs:   h.hub.GetVisibleAudienceFor(claims.UserID, serverIDs, presencePeers),
			Servers:         readyServers,
			MutedServerIDs:  mutedServerIDs,
			MutedChannelIDs: mutedChannelIDs,
			PrefStatus:      prefStatus,
		},
	})

	// Send voice states sync so frontend can initialize voiceStore.
	// Filter to servers the user belongs to — voice events are server-scoped,
	// so leaking states from foreign servers would be inconsistent with runtime broadcasts.
	if h.voiceStatesProvider != nil {
		userServers := make(map[string]bool, len(serverIDs))
		for _, id := range serverIDs {
			userServers[id] = true
		}

		allStates := h.voiceStatesProvider.GetAllVoiceStates()
		items := make([]VoiceStateItem, 0, len(allStates))
		visibleChannels := make(map[string]struct{})
		for _, s := range allStates {
			if !userServers[s.ServerID] {
				continue
			}
			items = append(items, VoiceStateItem{
				UserID:           s.UserID,
				ChannelID:        s.ChannelID,
				ChannelName:      s.ChannelName,
				ServerID:         s.ServerID,
				Username:         s.Username,
				DisplayName:      s.DisplayName,
				AvatarURL:        h.urlSigner.SignURL(s.AvatarURL),
				IsMuted:          s.IsMuted,
				IsDeafened:       s.IsDeafened,
				IsStreaming:      s.IsStreaming,
				ShareQuality:     s.ShareQuality,
				IsServerMuted:    s.IsServerMuted,
				IsServerDeafened: s.IsServerDeafened,
			})
			visibleChannels[s.ChannelID] = struct{}{}
		}
		// Filter timers to channels the user can actually see (server scoping).
		allTimers := h.voiceStatesProvider.GetActiveChannelTimers()
		timers := make(map[string]int64, len(visibleChannels))
		for cid := range visibleChannels {
			if t, ok := allTimers[cid]; ok {
				timers[cid] = t
			}
		}
		client.sendEvent(Event{
			Op:   OpVoiceStatesSync,
			Data: VoiceStatesSyncData{States: items, ChannelTimers: timers},
		})
	}

	// Re-deliver a ringing incoming call so a receiver who connects after missing the
	// live event (was offline / tapped a push notification) still sees the overlay.
	if h.incomingCallProvider != nil {
		if bc := h.incomingCallProvider.PendingIncomingCall(claims.UserID); bc != nil {
			client.sendEvent(Event{Op: OpP2PCallInitiate, Data: bc})
		}
	}

	// Start pumps — WritePump + eventPump in goroutines, ReadPump blocks until disconnect.
	// eventPump drains the ordered inbound queue; both exit when done is closed on unregister.
	go client.WritePump()
	go client.eventPump()
	client.ReadPump()
}
