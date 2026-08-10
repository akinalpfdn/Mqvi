package ws

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/akinalp/mqvi/models"
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
	IsOnline(userID string) bool
	GetOnlineUserIDs() []string
	GetOnlineUserIDsForServer(serverID string) []string
	GetOnlineCountsForServers(serverIDs []string) map[string]int
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
	PresenceAudienceProvider
}

// PresencePeerRegistrar records a relationship that carries presence — a friendship or a DM —
// on both users' live connections.
//
// Without it, a relationship formed mid-session would not carry presence until one side
// reconnected, because each connection loads its peer list once at connect.
type PresencePeerRegistrar interface {
	AddPresencePeer(userA, userB string)
	// RemovePresencePeer drops the entitlement when the relationship ends — unfriend or block.
	// A shared server still entitles them; only the friend/DM half is withdrawn.
	RemovePresencePeer(userA, userB string)
}

// BroadcastAndRegisterPeers — used by the services that create those relationships.
type BroadcastAndRegisterPeers interface {
	Broadcaster
	PresencePeerRegistrar
}

// PresenceAudienceProvider answers who is entitled to see a user's presence change.
// Its own interface rather than folded into UserStateProvider: MemberService needs this one
// method and none of the other online-state queries.
type PresenceAudienceProvider interface {
	GetPresenceAudience(userID string) []string
}

// EventPublisher is the full Hub interface. Used in ws package and main wire-up.
type EventPublisher interface {
	Broadcaster
	UserStateProvider
	ClientManager
	PresenceAudienceProvider
	PresencePeerRegistrar
}

// UserConnectionCallback is called on first-connect.
// Second arg is unused (kept for signature compatibility).
type UserConnectionCallback func(userID, _ string)

// UserDisconnectCallback is called when a user's last connection closes. The audience is captured
// before the connection is torn out of the hub — afterwards the user is no longer in h.clients and
// it could not be derived at all, so nobody would learn they went offline.
type UserDisconnectCallback func(userID string, audience []string)

// SessionDisconnectCallback fires on EVERY connection close, with the connection that died.
// A call is owned by a connection, not a user — see p2pCallService.HandleSessionDisconnect.
type SessionDisconnectCallback func(userID, sessionID string)

// ─── Voice Callback Types ───

// VoiceJoinCallback — user wants to join a voice channel.
// displayName may be empty if the user hasn't set one.
type VoiceJoinCallback func(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool)

// VoiceLeaveCallback — user wants to leave a voice channel.
type VoiceLeaveCallback func(userID string)

// VoiceStateUpdateCallback — user toggled mute/deafen/stream.
// Nil pointers mean "no change" (partial update).
type VoiceStateUpdateCallback func(userID string, isMuted, isDeafened, isStreaming *bool, shareQuality *string)

// PresenceManualUpdateCallback — user changed presence (manual or auto-idle).
// isAuto distinguishes auto-idle from manual status changes (only manual persists to pref_status).
type PresenceManualUpdateCallback func(userID string, status string, isAuto bool)

// VoiceAdminStateUpdateCallback — admin server-muted/deafened a user.
// Nil pointers mean "no change" (partial update).
type VoiceAdminStateUpdateCallback func(adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool)

// VoiceMoveUserCallback — authorized user moved someone between voice channels.
type VoiceMoveUserCallback func(moverUserID, targetUserID, targetChannelID string)

// VoiceDisconnectUserCallback — authorized user kicked someone from voice.
type VoiceDisconnectUserCallback func(disconnecterUserID, targetUserID string)

// ScreenShareWatchCallback — user started/stopped watching a screen share.
type ScreenShareWatchCallback func(viewerUserID, streamerUserID string, watching bool)

// VoiceActivityCallback — client reports activity (mouse/keyboard/VAD/screen share).
type VoiceActivityCallback func(userID string)

// ─── P2P Call Callback Types ───

type P2PCallInitiateCallback func(callerID, sessionID string, data P2PCallInitiateData)
type P2PCallAcceptCallback func(userID, sessionID, deviceID string, data P2PCallAcceptData)
type P2PCallDeclineCallback func(userID, deviceID string, data P2PCallDeclineData)
type P2PCallEndCallback func(userID, deviceID, callID string)
type P2PCallResumeCallback func(userID, sessionID, callID string)

// P2PSignalCallback — WebRTC signaling data relayed to the other peer.
type P2PSignalCallback func(senderID, senderSessionID string, data P2PSignalData)

// ChannelTypingCallback — typing indicator in a server channel.
// Wired in main.go: validates channel access, broadcasts to server members only.
type ChannelTypingCallback func(senderUserID, senderUsername, channelID string)

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

	// serverClients: serverID -> set of Client connections for that server's members.
	// Maintained in sync with client.serverIDs and h.clients.
	// Enables O(server_size) BroadcastToServer instead of O(total_clients).
	// Protected by mu (same lock as clients).
	serverClients map[string]map[*Client]bool

	mu sync.RWMutex

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

	// maxConnectionsPerUser caps concurrent sockets for one account. Lives on the hub rather than
	// the handler because only the hub can enforce it: the check has to happen under the same lock
	// that registers, or it races the handshake. Protected by mu.
	//
	// 0 means unlimited, which is what an unwired hub gets — config.Load refuses a configured 0, so
	// production cannot reach that state by accident.
	maxConnectionsPerUser int

	// refusals tallies rejected connections for a periodic log. All three refusal kinds land here
	// rather than in the handler, because one of them is decided by the hub and splitting the tally
	// would mean two independent flush clocks reporting halves of the same story.
	refusals refusalCounter

	// Presence callbacks — set in main.go.
	// Called in separate goroutines to avoid deadlock (callback may call Broadcast
	// which needs RLock, but add/removeClient holds Lock).
	onUserFirstConnect      UserConnectionCallback
	onUserFullyDisconnected UserDisconnectCallback
	onSessionDisconnect     SessionDisconnectCallback

	// Voice callbacks — set in main.go
	onVoiceJoin             VoiceJoinCallback
	onVoiceLeave            VoiceLeaveCallback
	onVoiceStateUpdate      VoiceStateUpdateCallback
	onVoiceAdminStateUpdate VoiceAdminStateUpdateCallback
	onVoiceMoveUser         VoiceMoveUserCallback
	onVoiceDisconnectUser   VoiceDisconnectUserCallback
	onVoiceActivity         VoiceActivityCallback

	onPresenceManualUpdate PresenceManualUpdateCallback

	// P2P Call callbacks — set in main.go
	onP2PCallInitiate P2PCallInitiateCallback
	onP2PCallAccept   P2PCallAcceptCallback
	onP2PCallDecline  P2PCallDeclineCallback
	onP2PCallEnd      P2PCallEndCallback
	onP2PCallResume   P2PCallResumeCallback
	onP2PSignal       P2PSignalCallback

	// Channel typing callback — set in main.go
	onChannelTyping ChannelTypingCallback

	// DM callbacks — set in main.go
	onDMTyping DMTypingCallback

	// Screen share viewer tracking — set in main.go
	onScreenShareWatch ScreenShareWatchCallback

	// Structured app logger — set in main.go
	appLogger AppLogger
}

func NewHub() *Hub {
	return &Hub{
		clients:        make(map[string]map[*Client]bool),
		serverClients:  make(map[string]map[*Client]bool),
		register:       make(chan *Client),
		unregister:     make(chan *Client),
		userInfos:      make(map[string]cachedUserInfo),
		invisibleUsers: make(map[string]bool),
	}
}

// addClientToServerIndex adds a client to the serverClients index for serverID.
// MUST be called under h.mu Lock.
func (h *Hub) addClientToServerIndex(client *Client, serverID string) {
	if _, ok := h.serverClients[serverID]; !ok {
		h.serverClients[serverID] = make(map[*Client]bool)
	}
	h.serverClients[serverID][client] = true
}

// removeClientFromServerIndex removes a client from the serverClients index.
// MUST be called under h.mu Lock.
func (h *Hub) removeClientFromServerIndex(client *Client, serverID string) {
	if clients, ok := h.serverClients[serverID]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.serverClients, serverID)
		}
	}
}

// Run is the Hub's main event loop. Started as `go hub.Run()` in main.go.
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			if !h.addClient(client) {
				// Over the cap. Closing the socket makes ReadPump exit, which unregisters — and
				// removeClient ignores a client it never held.
				client.markClosed()
				_ = client.conn.Close()
			}

		case client := <-h.unregister:
			h.removeClient(client)
		}
	}
}

// addClient registers a new client. Fires OnUserFirstConnect for the user's
// first connection. For subsequent connections, recomputes aggregate status.
//
// Returns false when the user is already at the connection cap, leaving the client unregistered —
// the caller closes it.
func (h *Hub) addClient(client *Client) bool {
	h.mu.Lock()

	// The cap, enforced where it cannot be raced. The handler checks it too, but that check reads
	// the count and lets go, and the count does not rise until this function runs — an upgrade,
	// four DB queries and a channel hop later. Anything opening connections faster than a handshake
	// completes reads the same stale number and sails past, which made the "cap" whatever the rate
	// limiter allowed rather than what was configured. Here the check and the registration are the
	// same critical section, so there is no window at all.
	//
	// Refusing this late means closing an open socket instead of answering 429. That is the price
	// of correctness, and it is only paid by connections that raced — the ordinary over-cap connect
	// is still refused politely by the handler before the upgrade.
	//
	// Reporting the refusal instead of tearing down here keeps the socket handling in Run, so this
	// stays a pure decision about hub state and can be tested without a real connection.
	if h.maxConnectionsPerUser > 0 && len(h.clients[client.userID]) >= h.maxConnectionsPerUser {
		h.mu.Unlock()
		// Counted, never logged per event: this is the racing path, so it is the one an attacker
		// produces in volume — and it runs in Run, where a synchronous write would stall every
		// connect and disconnect on the server behind it.
		h.countRefusal(&h.refusals.atRegister)
		return false
	}

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

	// Index this client by its serverIDs (set by handler.go before register).
	for _, sid := range client.serverIDs {
		h.addClientToServerIndex(client, sid)
	}

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
		go h.onPresenceManualUpdate(client.userID, aggregateForExisting, true)
	}

	return true
}

// removeClient unregisters a client and closes its send channel.
// Fires OnUserFullyDisconnected when the last connection closes, OnSessionDisconnect on EVERY
// one. Otherwise recomputes and broadcasts aggregate status.
func (h *Hub) removeClient(client *Client) {
	h.mu.Lock()

	var fullyDisconnected bool
	var partialDisconnect bool
	var removed bool
	var userID string
	var newAggregate string
	// Captured before the delete below: once the last connection is gone the user is no longer in
	// h.clients, and an audience derived afterwards would be empty — so nobody would ever learn
	// they went offline.
	var audience []string

	if clients, ok := h.clients[client.userID]; ok {
		if _, exists := clients[client]; exists {
			audience = h.presenceAudienceLocked(client.userID)
			delete(clients, client)
			client.markClosed()
			removed = true

			// Remove this client from all server indexes it belonged to.
			for _, sid := range client.serverIDs {
				h.removeClientFromServerIndex(client, sid)
			}

			if len(clients) == 0 {
				delete(h.clients, client.userID)
				fullyDisconnected = true
				userID = client.userID
				log.Printf("[ws] user fully disconnected: %s", client.userID)
				h.logEvent(models.LogLevelInfo, models.LogCategoryWS, &client.userID,
					"user fully disconnected (all tabs closed)", nil)
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

	// Every connection close, not just the last. A call belongs to a CONNECTION: if only the
	// last-disconnect hook can tear it down, a user whose call-carrying socket dies while another
	// device stays signed in is left in the call forever — and, because an accepted call has no
	// ring timer, nothing ever cleans it up.
	if removed && h.onSessionDisconnect != nil {
		go h.onSessionDisconnect(client.userID, client.sessionID)
	}

	if fullyDisconnected && h.onUserFullyDisconnected != nil {
		go h.onUserFullyDisconnected(userID, audience)
	} else if partialDisconnect && h.onPresenceManualUpdate != nil {
		go h.onPresenceManualUpdate(userID, newAggregate, true)
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
			if !client.trySend(data) {
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

	h.mu.RLock()
	defer h.mu.RUnlock()

	// Look the recipients up rather than walking every connection and filtering. Presence is the
	// caller that made this matter: scoping the audience achieved nothing while delivering it
	// still cost a pass over the whole platform on every idle flip.
	//
	// Deduped because a repeated id would send twice. Callers build their lists from maps today,
	// but that is their invariant, not this function's.
	seen := make(map[string]bool, len(userIDs))
	for _, userID := range userIDs {
		if seen[userID] {
			continue
		}
		seen[userID] = true

		for client := range h.clients[userID] {
			if !client.trySend(data) {
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
			if !client.trySend(data) {
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
			if !client.trySend(data) {
				go func(c *Client) { h.unregister <- c }(client)
			}
		}
	}
}

// IsOnline reports whether the user has ANY live connection.
//
// Used only to decide whether a DM push is worth DEFERRING: with no socket anywhere, nobody
// could read the message, so waiting to see if they did buys nothing — push immediately. This
// is the safe direction. It is NOT the old presence gate ("has a socket → suppress"), which
// swallowed the push for a backgrounded phone that was still holding its WebSocket. This one
// can only make delivery faster, never suppress it.
func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

// GetOnlineUserIDs returns all connected user IDs (including invisible).

// Counts reports live sockets and the users behind them. A jump in sockets per user is the
// shape of a reconnect loop, which /health/ready surfaces before it becomes an outage.
func (h *Hub) Counts() (connections, users int) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, set := range h.clients {
		connections += len(set)
	}
	return connections, len(h.clients)
}

func (h *Hub) GetOnlineUserIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0, len(h.clients))
	for userID := range h.clients {
		ids = append(ids, userID)
	}
	return ids
}

// GetOnlineUserIDsForServer returns deduplicated user IDs of clients in the given server.
// Used by services to scope permission checks to server members only.
func (h *Hub) GetOnlineUserIDsForServer(serverID string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	clients, ok := h.serverClients[serverID]
	if !ok {
		return nil
	}

	seen := make(map[string]bool, len(clients))
	for client := range clients {
		seen[client.userID] = true
	}
	ids := make([]string, 0, len(seen))
	for uid := range seen {
		ids = append(ids, uid)
	}
	return ids
}

// GetPresenceAudience returns the online users entitled to see a presence change for userID:
// everyone sharing one of their servers, plus their friends and DM partners.
//
// Presence used to go to every connected client on the platform. With many users online that made
// each idle flip an O(all connections) fan-out, and it told people who share nothing with the
// subject when that person is at their desk.
//
// Entirely in memory: server membership comes from the serverClients index, and the friend/DM half
// from the peer list each client loaded at connect. Nothing here touches the database, because
// this runs on every idle flip.
//
// refusalCounter tallies rejected connections for the periodic log.
//
// Counted rather than logged per event: what gets rejected is a churn loop or a connection race,
// so a line per refusal hands the disk to whoever is causing them — and the registration refusal
// happens inside Run, the single goroutine every connect and disconnect passes through, where
// synchronous log I/O would stall the whole hub. Same call the per-connection event limiter made
// in phase 43.
type refusalCounter struct {
	mu         sync.Mutex
	overCap    int // refused before the upgrade, politely
	atRegister int // refused after the handshake, having raced past the early check
	tooFast    int // over the handshake rate limit
	lastFlush  time.Time
}

// refusalFlushInterval bounds how often the tally reaches the log: one line a minute at worst,
// however hard the door is being hammered.
const refusalFlushInterval = time.Minute

// countRefusal records one refusal and emits at most one aggregate line per interval.
//
// The first refusal after a quiet spell flushes immediately — lastFlush starts at the zero time —
// so an operator learns the door started refusing without waiting out an interval.
func (h *Hub) countRefusal(kind *int) {
	h.refusals.mu.Lock()
	*kind++
	overCap, atRegister, tooFast := h.refusals.overCap, h.refusals.atRegister, h.refusals.tooFast
	due := time.Since(h.refusals.lastFlush) >= refusalFlushInterval
	if due {
		h.refusals.lastFlush = time.Now()
		h.refusals.overCap, h.refusals.atRegister, h.refusals.tooFast = 0, 0, 0
	}
	h.refusals.mu.Unlock()

	if due {
		log.Printf("[ws] refused connections in the last interval: %d over the per-user cap, %d of those at registration, %d too fast",
			overCap, atRegister, tooFast)
	}
}

// RefusedOverCap and RefusedTooFast are the handler's two pre-upgrade refusal kinds.
func (h *Hub) RefusedOverCap() { h.countRefusal(&h.refusals.overCap) }
func (h *Hub) RefusedTooFast() { h.countRefusal(&h.refusals.tooFast) }

// SetMaxConnectionsPerUser sets the concurrent-socket cap. 0 disables it, which only an unwired
// hub sees — config.Load rejects a configured 0.
func (h *Hub) SetMaxConnectionsPerUser(n int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.maxConnectionsPerUser = n
}

// AtConnectionLimit reports whether the user is already at the cap.
//
// This is a fast path for the handshake, not the enforcement point. It reads and releases, and the
// count does not rise until `register` is picked up — a whole upgrade and four DB queries later —
// so connects fired faster than a handshake completes all see the same stale number. Its job is to
// refuse the ordinary case cheaply, with a clean 429 and before any DB work. addClient is what
// actually holds the line.
//
// A socket whose peer vanished still counts until ReadPump notices, up to pongWait.
func (h *Hub) AtConnectionLimit(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.maxConnectionsPerUser > 0 && len(h.clients[userID]) >= h.maxConnectionsPerUser
}

// The subject is included — their own clients use the event to sync their status across devices.
func (h *Hub) GetPresenceAudience(userID string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.presenceAudienceLocked(userID)
}

// presenceAudienceLocked gathers the subject's memberships from their live connections, then
// resolves the audience. Separate from GetPresenceAudience so removeClient can call it while
// already holding the write lock, before it deletes the user.
// MUST be called under h.mu (read or write).
func (h *Hub) presenceAudienceLocked(userID string) []string {
	var serverIDs, peerIDs []string
	for client := range h.clients[userID] {
		serverIDs = append(serverIDs, client.serverIDs...)
		peerIDs = append(peerIDs, client.presencePeerIDs...)
	}
	return h.resolveAudienceLocked(userID, serverIDs, peerIDs)
}

// resolveAudienceLocked takes the memberships explicitly rather than reading them off h.clients,
// because a connection that is still being set up is not in there yet: `register` is a channel
// send picked up asynchronously by Run, so the ready payload is built before addClient has run.
// Deriving the audience from the map at that moment would return only the subject.
// MUST be called under h.mu (read or write).
func (h *Hub) resolveAudienceLocked(userID string, serverIDs, peerIDs []string) []string {
	audience := make(map[string]bool)
	audience[userID] = true

	for _, sid := range serverIDs {
		for peer := range h.serverClients[sid] {
			audience[peer.userID] = true
		}
	}
	for _, peerID := range peerIDs {
		// Only if they are actually connected — an offline friend has nothing to receive.
		if len(h.clients[peerID]) > 0 {
			audience[peerID] = true
		}
	}

	ids := make([]string, 0, len(audience))
	for uid := range audience {
		ids = append(ids, uid)
	}
	return ids
}

// RemovePresencePeer withdraws a friend/DM presence entitlement when the relationship ends.
//
// The counterpart to AddPresencePeer: without it an unfriended or blocked user keeps seeing the
// other's presence until one of them reconnects, because each connection loads its peer list once.
// A shared server still entitles them — only the friend/DM half is dropped here.
func (h *Hub) RemovePresencePeer(userA, userB string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// A new slice, not the `s[:0]` filter-in-place idiom: the handler keeps a local pointing at the
	// same backing array while it builds the ready payload, and rewriting the array's elements
	// under it is exactly the unsynchronised read this connection path was just fixed for.
	// Appending is safe by comparison — it only writes past the length the handler's local sees.
	drop := func(owner, peer string) {
		for client := range h.clients[owner] {
			kept := make([]string, 0, len(client.presencePeerIDs))
			for _, existing := range client.presencePeerIDs {
				if existing != peer {
					kept = append(kept, existing)
				}
			}
			client.presencePeerIDs = kept
		}
	}
	drop(userA, userB)
	drop(userB, userA)
}

// GetVisibleAudienceFor is the `ready` snapshot counterpart to GetPresenceAudience: the online,
// non-invisible users this one is entitled to see.
//
// It has to be the same set the live events use. Seeding the client from a platform-wide list
// while only scoped events follow would leave people painted online forever — the client would
// never receive the update saying otherwise.
//
// The relationship is symmetric: sharing a server, a friendship or a DM entitles both directions.
// Invisibility is not — an invisible user still receives everyone else's presence, so it is
// filtered here and not in GetPresenceAudience.
func (h *Hub) GetVisibleAudienceFor(userID string, serverIDs, peerIDs []string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	audience := h.resolveAudienceLocked(userID, serverIDs, peerIDs)
	visible := make([]string, 0, len(audience))
	for _, uid := range audience {
		if h.invisibleUsers[uid] {
			continue
		}
		visible = append(visible, uid)
	}
	return visible
}

// AddPresencePeer records a new friendship or DM partnership on both users' live connections.
//
// Without it a relationship formed mid-session would not carry presence until one side reconnected
// — a regression against the platform-wide broadcast this replaced. Called from the services that
// already know: friendship accept and DM channel create.
func (h *Hub) AddPresencePeer(userA, userB string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Per connection, not per user: a multi-device user has one Client each, and each carries its
	// own list. Skipping the rest once one already knows would leave the other devices blind.
	add := func(owner, peer string) {
		for client := range h.clients[owner] {
			known := false
			for _, existing := range client.presencePeerIDs {
				if existing == peer {
					known = true
					break
				}
			}
			if !known {
				client.presencePeerIDs = append(client.presencePeerIDs, peer)
			}
		}
	}
	add(userA, userB)
	add(userB, userA)
}

// GetOnlineCountsForServers returns the count of distinct connected users per server, computed
// under a single read lock (batch form of GetOnlineUserIDsForServer for list endpoints).
func (h *Hub) GetOnlineCountsForServers(serverIDs []string) map[string]int {
	h.mu.RLock()
	defer h.mu.RUnlock()

	out := make(map[string]int, len(serverIDs))
	for _, serverID := range serverIDs {
		clients, ok := h.serverClients[serverID]
		if !ok {
			out[serverID] = 0
			continue
		}
		seen := make(map[string]struct{}, len(clients))
		for client := range clients {
			seen[client.userID] = struct{}{}
		}
		out[serverID] = len(seen)
	}
	return out
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
func (h *Hub) OnUserFullyDisconnected(cb UserDisconnectCallback) {
	h.onUserFullyDisconnected = cb
}

// SetAppLogger sets the structured app logger for WS events.
func (h *Hub) SetAppLogger(logger AppLogger) {
	h.appLogger = logger
}

// logEvent is a helper that safely logs via appLogger if set.
func (h *Hub) logEvent(level models.LogLevel, category models.LogCategory, userID *string, message string, metadata map[string]string) {
	if h.appLogger != nil {
		h.appLogger.Log(level, category, userID, nil, message, metadata)
	}
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

func (h *Hub) OnVoiceActivity(cb VoiceActivityCallback) {
	h.onVoiceActivity = cb
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

func (h *Hub) OnP2PCallResume(cb P2PCallResumeCallback) {
	h.onP2PCallResume = cb
}

func (h *Hub) OnP2PSignal(cb P2PSignalCallback) {
	h.onP2PSignal = cb
}

func (h *Hub) OnChannelTyping(cb ChannelTypingCallback) {
	h.onChannelTyping = cb
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
// serverShutdownGrace is how long the hub waits after telling clients it is going down, so their
// WritePump flushes that frame before the socket closes. A single buffered frame writes in well
// under a millisecond; the window is generous on purpose and is a small fraction of the shutdown
// budget (srv.Shutdown's 5s, systemd's TimeoutStopSec).
const serverShutdownGrace = 250 * time.Millisecond

func (h *Hub) Shutdown() {
	// Snapshot the clients under the lock, then release it — the grace period below must not hold
	// the hub, or every in-flight ReadPump unregister would block on it.
	h.mu.Lock()
	var all []*Client
	for _, clients := range h.clients {
		for client := range clients {
			all = append(all, client)
		}
	}
	h.mu.Unlock()

	// Tell every connection we are going down. Non-blocking: a client whose buffer is already full
	// is lagging and will just reconnect the old way. done is still open here, so each WritePump
	// drains this frame from `send` before there is any close frame to race it.
	if data, err := json.Marshal(Event{Op: OpServerShutdown}); err == nil {
		for _, c := range all {
			c.trySend(data)
		}
		time.Sleep(serverShutdownGrace)
	}

	h.mu.Lock()
	for _, c := range all {
		c.markClosed()
	}
	h.clients = make(map[string]map[*Client]bool)
	h.serverClients = make(map[string]map[*Client]bool)
	h.mu.Unlock()
	log.Println("[ws] hub shut down, all connections closed")
}

// ─── Multi-Server Broadcast ───

// BroadcastToServer sends an event to all connected members of a specific server.
// Automatically injects server_id into the event so clients can route to the correct cache.
// Uses serverClients index for O(server_size) lookup instead of scanning all clients.
func (h *Hub) BroadcastToServer(serverID string, event Event) {
	event.Seq = h.seq.Add(1)
	event.ServerID = serverID

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal server broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.serverClients[serverID] {
		if !client.trySend(data) {
			go func(c *Client) { h.unregister <- c }(client)
		}
	}
}

// BroadcastToServerExcept sends to all server members except the specified user.
func (h *Hub) BroadcastToServerExcept(serverID, excludeUserID string, event Event) {
	event.Seq = h.seq.Add(1)
	event.ServerID = serverID

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal server broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.serverClients[serverID] {
		if client.userID == excludeUserID {
			continue
		}
		if !client.trySend(data) {
			go func(c *Client) { h.unregister <- c }(client)
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
				h.addClientToServerIndex(client, serverID)
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
					h.removeClientFromServerIndex(client, serverID)
					break
				}
			}
		}
	}
}

// SetClientServerIDs sets all server IDs for a client (at WS connect, from DB).
// Removes the client from any previously-indexed servers and re-indexes for the new set.
func (h *Hub) SetClientServerIDs(client *Client, serverIDs []string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, sid := range client.serverIDs {
		h.removeClientFromServerIndex(client, sid)
	}
	client.serverIDs = serverIDs
	for _, sid := range serverIDs {
		h.addClientToServerIndex(client, sid)
	}
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

// OnSessionDisconnect sets the callback fired on every connection close.
func (h *Hub) OnSessionDisconnect(cb SessionDisconnectCallback) {
	h.onSessionDisconnect = cb
}
