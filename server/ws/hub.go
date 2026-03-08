package ws

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
)

// ─── Interface Segregation ───
//
// Hub capabilities split into focused interfaces (ISP):
// - Broadcaster: event publishing (used by most services)
// - UserStateProvider: online user queries (message, p2p_call)
// - ClientManager: connection management (server, member)
//
// Composed interfaces:
// - BroadcastAndOnline = Broadcaster + UserStateProvider
// - BroadcastAndManage = Broadcaster + ClientManager
// - EventPublisher = all three (ws package + main wire-up)

// Broadcaster publishes events over WebSocket.
type Broadcaster interface {
	BroadcastToAll(event Event)
	BroadcastToAllExcept(excludeUserID string, event Event)
	BroadcastToUser(userID string, event Event)
	BroadcastToUsers(userIDs []string, event Event)
	BroadcastToServer(serverID string, event Event)
	BroadcastToServerExcept(serverID, excludeUserID string, event Event)
}

// UserStateProvider queries connected user state.
type UserStateProvider interface {
	GetOnlineUserIDs() []string
	GetVisibleOnlineUserIDs() []string
}

// ClientManager manages WebSocket client connections.
type ClientManager interface {
	SetInvisible(userID string, invisible bool)
	DisconnectUser(userID string)
	AddClientServerID(userID, serverID string)
	RemoveClientServerID(userID, serverID string)
}

// BroadcastAndOnline — used by MessageService, P2PCallService.
type BroadcastAndOnline interface {
	Broadcaster
	UserStateProvider
}

// BroadcastAndManage — used by ServerService, MemberService.
type BroadcastAndManage interface {
	Broadcaster
	ClientManager
}

// EventPublisher is the full Hub interface. Used in ws package and main wire-up.
type EventPublisher interface {
	Broadcaster
	UserStateProvider
	ClientManager
}

// UserConnectionCallback is called on first-connect and full-disconnect.
// prefStatus: client's preferred presence sent via WS query param.
// Used in OnUserFirstConnect to broadcast correct status immediately.
// Empty string for OnUserFullyDisconnected (unused).
type UserConnectionCallback func(userID, prefStatus string)

// ─── Voice Callback Types ───

// VoiceJoinCallback — user wants to join a voice channel.
// displayName may be empty if the user hasn't set one.
type VoiceJoinCallback func(userID, username, displayName, avatarURL, channelID string)

// VoiceLeaveCallback — user wants to leave a voice channel.
type VoiceLeaveCallback func(userID string)

// VoiceStateUpdateCallback — user toggled mute/deafen/stream.
// Nil pointers mean "no change" (partial update).
type VoiceStateUpdateCallback func(userID string, isMuted, isDeafened, isStreaming *bool)

// PresenceManualUpdateCallback — user manually changed presence (idle, dnd, etc.).
// Wired in main.go — handles DB persist + broadcast.
type PresenceManualUpdateCallback func(userID string, status string)

// VoiceAdminStateUpdateCallback — admin server-muted/deafened a user.
// Nil pointers mean "no change" (partial update).
type VoiceAdminStateUpdateCallback func(adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool)

// VoiceMoveUserCallback — authorized user moved someone between voice channels.
type VoiceMoveUserCallback func(moverUserID, targetUserID, targetChannelID string)

// VoiceDisconnectUserCallback — authorized user kicked someone from voice.
type VoiceDisconnectUserCallback func(disconnecterUserID, targetUserID string)

// ScreenShareWatchCallback — user started/stopped watching a screen share.
type ScreenShareWatchCallback func(viewerUserID, streamerUserID string, watching bool)

// ─── P2P Call Callback Types ───

type P2PCallInitiateCallback func(callerID string, data P2PCallInitiateData)
type P2PCallAcceptCallback func(userID string, data P2PCallAcceptData)
type P2PCallDeclineCallback func(userID string, data P2PCallDeclineData)
type P2PCallEndCallback func(userID string)

// P2PSignalCallback — WebRTC signaling data relayed to the other peer.
type P2PSignalCallback func(senderID string, data P2PSignalData)

// ─── DM Callback Types ───

// DMTypingCallback — typing indicator in a DM channel.
// Wired in main.go: looks up DM channel member, broadcasts to the other user.
type DMTypingCallback func(senderUserID, senderUsername, dmChannelID string)

// cachedUserInfo holds user info cached at WS connect time.
// Avoids DB lookups for typing/voice broadcasts.
type cachedUserInfo struct {
	Username    string
	DisplayName string
	AvatarURL   string
}

// Hub manages all WebSocket connections (Observer pattern).
// A single goroutine processes register/unregister via channels.
type Hub struct {
	// clients: userID -> set of Client connections (multi-tab support)
	clients map[string]map[*Client]bool
	mu      sync.RWMutex

	register   chan *Client
	unregister chan *Client

	// seq: monotonic counter for outbound event ordering
	seq atomic.Int64

	// userInfos: cached user info for typing/voice broadcasts
	userInfos map[string]cachedUserInfo
	userMu    sync.RWMutex

	// invisibleUsers: users with "offline" (invisible) status who are still connected.
	// Protected by mu (same lock as clients).
	invisibleUsers map[string]bool

	// Presence callbacks — set in main.go.
	// Called in separate goroutines to avoid deadlock (callback may call Broadcast
	// which needs RLock, but add/removeClient holds Lock).
	onUserFirstConnect      UserConnectionCallback
	onUserFullyDisconnected UserConnectionCallback

	// Voice callbacks — set in main.go
	onVoiceJoin             VoiceJoinCallback
	onVoiceLeave            VoiceLeaveCallback
	onVoiceStateUpdate      VoiceStateUpdateCallback
	onVoiceAdminStateUpdate VoiceAdminStateUpdateCallback
	onVoiceMoveUser         VoiceMoveUserCallback
	onVoiceDisconnectUser   VoiceDisconnectUserCallback

	onPresenceManualUpdate PresenceManualUpdateCallback

	// P2P Call callbacks — set in main.go
	onP2PCallInitiate P2PCallInitiateCallback
	onP2PCallAccept   P2PCallAcceptCallback
	onP2PCallDecline  P2PCallDeclineCallback
	onP2PCallEnd      P2PCallEndCallback
	onP2PSignal       P2PSignalCallback

	// DM callbacks — set in main.go
	onDMTyping DMTypingCallback

	// Screen share viewer tracking — set in main.go
	onScreenShareWatch ScreenShareWatchCallback
}

func NewHub() *Hub {
	return &Hub{
		clients:        make(map[string]map[*Client]bool),
		register:       make(chan *Client),
		unregister:     make(chan *Client),
		userInfos:      make(map[string]cachedUserInfo),
		invisibleUsers: make(map[string]bool),
	}
}

// Run is the Hub's main event loop. Started as `go hub.Run()` in main.go.
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

// addClient registers a new client. Fires OnUserFirstConnect for the user's
// first connection. For subsequent connections, recomputes aggregate status.
func (h *Hub) addClient(client *Client) {
	h.mu.Lock()

	isFirstConnection := len(h.clients[client.userID]) == 0

	// Set per-connection status from prefStatus or default to "online"
	if client.prefStatus != "" && client.prefStatus != "offline" {
		client.status = client.prefStatus
	} else if client.prefStatus == "offline" {
		client.status = "offline"
	} else {
		client.status = "online"
	}

	if _, ok := h.clients[client.userID]; !ok {
		h.clients[client.userID] = make(map[*Client]bool)
	}
	h.clients[client.userID][client] = true

	// New connection may change aggregate (e.g. existing idle + new online = online)
	var aggregateForExisting string
	if !isFirstConnection {
		aggregateForExisting = h.computeAggregateStatusLocked(client.userID)
	}

	log.Printf("[ws] client connected: user=%s status=%s (total connections for user: %d)",
		client.userID, client.status, len(h.clients[client.userID]))

	h.mu.Unlock()

	// Callbacks run outside lock in separate goroutines to prevent deadlock
	if isFirstConnection && h.onUserFirstConnect != nil {
		userID := client.userID
		prefStatus := client.prefStatus
		go h.onUserFirstConnect(userID, prefStatus)
	} else if !isFirstConnection && h.onPresenceManualUpdate != nil {
		go h.onPresenceManualUpdate(client.userID, aggregateForExisting)
	}
}

// removeClient unregisters a client and closes its send channel.
// Fires OnUserFullyDisconnected when the last connection closes.
// Otherwise recomputes and broadcasts aggregate status.
func (h *Hub) removeClient(client *Client) {
	h.mu.Lock()

	var fullyDisconnected bool
	var partialDisconnect bool
	var userID string
	var newAggregate string

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
				partialDisconnect = true
				userID = client.userID
				newAggregate = h.computeAggregateStatusLocked(client.userID)
				log.Printf("[ws] client disconnected: user=%s (remaining: %d, aggregate=%s)",
					client.userID, len(clients), newAggregate)
			}
		}
	}

	h.mu.Unlock()

	if fullyDisconnected && h.onUserFullyDisconnected != nil {
		go h.onUserFullyDisconnected(userID, "")
	} else if partialDisconnect && h.onPresenceManualUpdate != nil {
		go h.onPresenceManualUpdate(userID, newAggregate)
	}
}

// statusPriority defines presence precedence. Higher = more "active".
// When a user has multiple connections, the highest priority wins.
var statusPriority = map[string]int{
	"online":  4,
	"idle":    3,
	"dnd":     2,
	"offline": 1,
}

// computeAggregateStatusLocked returns the highest-priority status across
// all connections for a user. MUST be called under h.mu Lock/RLock.
func (h *Hub) computeAggregateStatusLocked(userID string) string {
	clients := h.clients[userID]
	if len(clients) == 0 {
		return "offline"
	}

	bestPriority := 0
	bestStatus := "offline"
	for client := range clients {
		p := statusPriority[client.status]
		if p > bestPriority {
			bestPriority = p
			bestStatus = client.status
		}
	}
	return bestStatus
}

// BroadcastToAll sends an event to all connected clients.
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
				// Buffer full — slow client, disconnect
				go func(c *Client) { h.unregister <- c }(client)
			}
		}
	}
}

// BroadcastToUsers sends an event to a specific set of users.
func (h *Hub) BroadcastToUsers(userIDs []string, event Event) {
	if len(userIDs) == 0 {
		return
	}

	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal broadcast event: %v", err)
		return
	}

	allowed := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		allowed[id] = true
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for userID, clients := range h.clients {
		if !allowed[userID] {
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

// BroadcastToAllExcept sends an event to everyone except the specified user.
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

// BroadcastToUser sends an event to all connections of a specific user.
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

// GetOnlineUserIDs returns all connected user IDs (including invisible).
func (h *Hub) GetOnlineUserIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0, len(h.clients))
	for userID := range h.clients {
		ids = append(ids, userID)
	}
	return ids
}

// GetVisibleOnlineUserIDs returns connected user IDs excluding invisible users.
// Used in the ready event to populate the online user list.
func (h *Hub) GetVisibleOnlineUserIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0, len(h.clients))
	for userID := range h.clients {
		if h.invisibleUsers[userID] {
			continue
		}
		ids = append(ids, userID)
	}
	return ids
}

// SetInvisible marks a user as invisible (connected but hidden from online lists).
func (h *Hub) SetInvisible(userID string, invisible bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if invisible {
		h.invisibleUsers[userID] = true
	} else {
		delete(h.invisibleUsers, userID)
	}
}

// SetUserInfo caches user profile data at WS connect time.
func (h *Hub) SetUserInfo(userID, username, displayName, avatarURL string) {
	h.userMu.Lock()
	defer h.userMu.Unlock()
	h.userInfos[userID] = cachedUserInfo{
		Username:    username,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
	}
}

func (h *Hub) getUserUsername(userID string) string {
	h.userMu.RLock()
	defer h.userMu.RUnlock()
	return h.userInfos[userID].Username
}

func (h *Hub) getUserInfo(userID string) cachedUserInfo {
	h.userMu.RLock()
	defer h.userMu.RUnlock()
	return h.userInfos[userID]
}

// OnUserFirstConnect sets the callback for a user's first WS connection.
// Not fired for additional tabs/connections from the same user.
func (h *Hub) OnUserFirstConnect(cb UserConnectionCallback) {
	h.onUserFirstConnect = cb
}

// OnUserFullyDisconnected sets the callback for when a user's last connection closes.
func (h *Hub) OnUserFullyDisconnected(cb UserConnectionCallback) {
	h.onUserFullyDisconnected = cb
}

// OnPresenceManualUpdate sets the callback for manual presence changes.
func (h *Hub) OnPresenceManualUpdate(cb PresenceManualUpdateCallback) {
	h.onPresenceManualUpdate = cb
}

func (h *Hub) OnVoiceJoin(cb VoiceJoinCallback) {
	h.onVoiceJoin = cb
}

func (h *Hub) OnVoiceLeave(cb VoiceLeaveCallback) {
	h.onVoiceLeave = cb
}

func (h *Hub) OnVoiceStateUpdate(cb VoiceStateUpdateCallback) {
	h.onVoiceStateUpdate = cb
}

func (h *Hub) OnVoiceAdminStateUpdate(cb VoiceAdminStateUpdateCallback) {
	h.onVoiceAdminStateUpdate = cb
}

func (h *Hub) OnVoiceMoveUser(cb VoiceMoveUserCallback) {
	h.onVoiceMoveUser = cb
}

func (h *Hub) OnVoiceDisconnectUser(cb VoiceDisconnectUserCallback) {
	h.onVoiceDisconnectUser = cb
}

func (h *Hub) OnP2PCallInitiate(cb P2PCallInitiateCallback) {
	h.onP2PCallInitiate = cb
}

func (h *Hub) OnP2PCallAccept(cb P2PCallAcceptCallback) {
	h.onP2PCallAccept = cb
}

func (h *Hub) OnP2PCallDecline(cb P2PCallDeclineCallback) {
	h.onP2PCallDecline = cb
}

func (h *Hub) OnP2PCallEnd(cb P2PCallEndCallback) {
	h.onP2PCallEnd = cb
}

func (h *Hub) OnP2PSignal(cb P2PSignalCallback) {
	h.onP2PSignal = cb
}

func (h *Hub) OnDMTyping(cb DMTypingCallback) {
	h.onDMTyping = cb
}

func (h *Hub) OnScreenShareWatch(cb ScreenShareWatchCallback) {
	h.onScreenShareWatch = cb
}

// DisconnectUser forcefully closes all WS connections for a user (e.g. after ban).
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

// Shutdown closes all client connections (graceful shutdown).
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

// ─── Multi-Server Broadcast ───

// BroadcastToServer sends an event to all connected members of a specific server.
func (h *Hub) BroadcastToServer(serverID string, event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal server broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, clients := range h.clients {
		for client := range clients {
			if !clientHasServer(client, serverID) {
				continue
			}
			select {
			case client.send <- data:
			default:
				go func(c *Client) { h.unregister <- c }(client)
			}
		}
	}
}

// BroadcastToServerExcept sends to all server members except the specified user.
func (h *Hub) BroadcastToServerExcept(serverID, excludeUserID string, event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal server broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for userID, clients := range h.clients {
		if userID == excludeUserID {
			continue
		}
		for client := range clients {
			if !clientHasServer(client, serverID) {
				continue
			}
			select {
			case client.send <- data:
			default:
				go func(c *Client) { h.unregister <- c }(client)
			}
		}
	}
}

// AddClientServerID adds a server ID to all connections of a user (on server join).
func (h *Hub) AddClientServerID(userID, serverID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.clients[userID]; ok {
		for client := range clients {
			if !clientHasServer(client, serverID) {
				client.serverIDs = append(client.serverIDs, serverID)
			}
		}
	}
}

// RemoveClientServerID removes a server ID from all connections of a user (on leave/kick).
func (h *Hub) RemoveClientServerID(userID, serverID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.clients[userID]; ok {
		for client := range clients {
			for i, id := range client.serverIDs {
				if id == serverID {
					client.serverIDs = append(client.serverIDs[:i], client.serverIDs[i+1:]...)
					break
				}
			}
		}
	}
}

// SetClientServerIDs sets all server IDs for a client (at WS connect, from DB).
func (h *Hub) SetClientServerIDs(client *Client, serverIDs []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	client.serverIDs = serverIDs
}

// clientHasServer checks if a client is a member of the given server.
// O(n) where n = number of servers per user (typically 3-10).
func clientHasServer(client *Client, serverID string) bool {
	for _, id := range client.serverIDs {
		if id == serverID {
			return true
		}
	}
	return false
}
