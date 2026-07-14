package ws

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 90 * time.Second // 3 missed heartbeats (30s × 3)
	maxMessageSize = 32768            // 32KB — WebRTC SDP + E2EE base64 overhead
	sendBufferSize = 256

	// eventQueueSize buffers inbound events for the per-connection ordered worker
	// (eventPump). Sized like sendBufferSize and well above the inbound rate-limit
	// burst (eventBurst + signalBurst), so under legitimate load it never fills; a
	// full queue means the worker is wedged (a stuck handler) and the connection is
	// dropped rather than blocking ReadPump.
	eventQueueSize = 256

	// Inbound per-connection rate limits. Every non-heartbeat frame is queued to the
	// connection's worker (eventPump), which does DB/broadcast work, so an unthrottled
	// socket is a DB-amplification DoS. Limits are far above legitimate use (a human
	// can't type/toggle 10×/sec), so they only bite floods. Heartbeat is exempt
	// (throttling it would force disconnects).
	eventBurst         = 20  // typing, presence, voice-state, calls: burst
	eventRefillPerSec  = 10  // ...sustained
	signalBurst        = 100 // p2p_signal: trickle-ICE bursts during call setup
	signalRefillPerSec = 50  // ...sustained
)

// Client represents a single WebSocket connection.
// Each connection runs three goroutines: ReadPump (read), WritePump (write), and
// eventPump (ordered inbound event handling).
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	userID string
	send   chan []byte
	mu     sync.Mutex // protects conn.WriteMessage

	// sessionID identifies this CONNECTION among the user's other ones. A user can be signed in
	// on several devices and events are broadcast to all of them, so anything that must act on
	// exactly ONE device (accepting a call) is tagged with it. Sent to the client in the ready
	// event; immutable after construction.
	sessionID string

	// deviceID identifies the INSTALLATION behind this connection, and is the same id the
	// device's push token is registered under. It is what lets the server skip the device that
	// just answered a call when it tells the rest to stop ringing — without it the cancel push
	// goes to every device, and each platform needs a local hack to work out whether it was
	// meant for them. Empty for clients that predate it.
	deviceID string

	// events is the per-connection inbound queue drained by a single eventPump
	// goroutine. ReadPump enqueues here (except heartbeat, handled inline) so a
	// connection's events are processed strictly in arrival order — a voice_join
	// is fully applied before a following state_update/activity/screen_share event
	// that would otherwise race it and be silently dropped (S6). Never closed
	// (same discipline as send); eventPump exits on done.
	events chan Event

	// done is closed once (removeClient/Shutdown) to signal WritePump to exit and to
	// guard all sends. The send channel itself is NEVER closed — closing it is what
	// would let a concurrent send (e.g. a heartbeat ack from ReadPump) panic.
	done      chan struct{}
	closeOnce sync.Once

	// Per-connection inbound rate limiters (see eventBurst/signalBurst). Signaling gets
	// its own generous bucket so ICE bursts never starve, or get starved by, chat events.
	eventLimiter  *ratelimit.TokenBucket
	signalLimiter *ratelimit.TokenBucket

	// serverIDs: servers this user belongs to. Populated from DB at connect,
	// updated on join/leave. Used by BroadcastToServer for filtering.
	serverIDs []string

	// prefStatus: user's preferred presence loaded from DB at connect time.
	// Used by addClient to set initial per-connection status.
	prefStatus string

	// status: per-connection presence. Hub aggregates across all connections
	// to determine the user's visible status (highest priority wins).
	// Accessed under Hub.mu.
	status string

}

// ReadPump reads messages from the WebSocket and dispatches events.
// Runs until the connection closes, then unregisters from Hub.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)

	if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		log.Printf("[ws] failed to set read deadline for user %s: %v", c.userID, err)
		return
	}

	for {
		_, rawMessage, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[ws] unexpected close for user %s: %v", c.userID, err)
				c.hub.logEvent(models.LogLevelWarn, models.LogCategoryWS, &c.userID,
					"WebSocket unexpected close", map[string]string{"error": err.Error()})
			}
			return
		}

		var event Event
		if err := json.Unmarshal(rawMessage, &event); err != nil {
			// Malformed frame: drop quietly. No per-frame log — a garbage-frame flood would
			// otherwise amplify into unbounded log/disk I/O (a DoS the rate limiter, which
			// runs post-parse in handleEvent, can't throttle).
			continue
		}

		c.handleEvent(event)
	}
}

// eventHandlers maps WS operation codes to client handler functions run by eventPump.
// Populated once in init() — read-only after startup, no concurrency concern.
// To add a new event type, add a method on *Client and register it here.
//
// OpHeartbeat is intentionally absent: it is handled inline on ReadPump (see
// handleEvent) so the read-deadline reset is never delayed behind queued work.
var eventHandlers map[string]func(c *Client, event Event)

func init() {
	eventHandlers = map[string]func(c *Client, event Event){
		OpTyping:                (*Client).handleTyping,
		OpPresenceUpdate:        (*Client).handlePresenceUpdate,
		OpVoiceJoin:             (*Client).handleVoiceJoin,
		OpVoiceLeave:            func(c *Client, _ Event) { c.handleVoiceLeave() },
		OpVoiceStateUpdateReq:   (*Client).handleVoiceStateUpdate,
		OpVoiceAdminStateUpdate: (*Client).handleVoiceAdminStateUpdate,
		OpVoiceMoveUser:         (*Client).handleVoiceMoveUser,
		OpVoiceDisconnectUser:   (*Client).handleVoiceDisconnectUser,
		OpScreenShareWatch:      (*Client).handleScreenShareWatch,
		OpVoiceActivity:         func(c *Client, _ Event) { c.handleVoiceActivity() },
		OpDMTypingStart:         (*Client).handleDMTyping,
		OpP2PCallInitiate:       (*Client).handleP2PCallInitiate,
		OpP2PCallAccept:         (*Client).handleP2PCallAccept,
		OpP2PCallDecline:        (*Client).handleP2PCallDecline,
		OpP2PCallEnd:            (*Client).handleP2PCallEnd,
		OpP2PCallResume:         (*Client).handleP2PCallResume,
		OpP2PSignal:             (*Client).handleP2PSignal,
	}
}

// handleEvent runs on ReadPump. Heartbeat is handled inline (its read-deadline reset
// must not wait behind queued work); every other event is rate-limited and handed to
// the per-connection ordered worker (eventPump) so intra-connection order is preserved
// while DB/LiveKit work stays off the read loop.
func (c *Client) handleEvent(event Event) {
	if event.Op == OpHeartbeat {
		c.handleHeartbeat(event)
		return
	}
	// Rate-limit FIRST — before the unknown-op check — so a flood of unknown/garbage ops is
	// throttled at the source instead of amplifying into unbounded logging that bypasses the
	// limiter (a log/disk DoS). Unknown ops draw from the general bucket (allowEvent default).
	if !c.allowEvent(event.Op) {
		// Over-limit: drop the frame and keep the connection. We deliberately do NOT
		// disconnect (a momentary UI spike shouldn't kill a live call) and do NOT log
		// per drop (that would just move the flood to the log/disk).
		return
	}
	if _, ok := eventHandlers[event.Op]; !ok {
		// Unknown op: drop quietly. No per-frame log (same reason as the over-limit drop).
		return
	}
	if !c.enqueueEvent(event) {
		// Queue full while still open — the worker is wedged on a stuck handler.
		// Drop the connection (mirrors sendEvent's buffer-full behavior) rather than
		// block ReadPump, which would stall heartbeat handling and force disconnects.
		log.Printf("[ws] event queue full for user %s, dropping connection", c.userID)
		c.hub.unregister <- c
	}
}

// enqueueEvent hands an event to the per-connection worker without ever blocking
// ReadPump. Returns false only when the queue is full AND the client is still open
// (caller drops the connection). A client being torn down returns true (no-op) — the
// events channel is never closed, so this can't send on a closed channel.
func (c *Client) enqueueEvent(event Event) bool {
	select {
	case <-c.done:
		return true
	default:
	}
	select {
	case c.events <- event:
		return true
	case <-c.done:
		return true
	default:
		return false
	}
}

// eventPump drains this connection's inbound events one at a time, in arrival order.
// A single worker per connection guarantees a voice_join is fully applied before a
// following state_update/activity/screen_share event (fixes S6's silent drop), while
// keeping each handler's DB/LiveKit work off ReadPump. Cross-connection throughput is
// unchanged — every connection has its own eventPump. Exits when done is closed.
func (c *Client) eventPump() {
	for {
		select {
		case event := <-c.events:
			if handler, ok := eventHandlers[event.Op]; ok {
				handler(c, event)
			}
		case <-c.done:
			return
		}
	}
}

// allowEvent applies the inbound rate limit for an op. Heartbeat is always allowed;
// p2p_signal uses the generous signaling bucket; everything else uses the general bucket.
func (c *Client) allowEvent(op string) bool {
	switch op {
	case OpHeartbeat:
		return true
	case OpP2PSignal:
		return c.signalLimiter == nil || c.signalLimiter.Allow()
	default:
		return c.eventLimiter == nil || c.eventLimiter.Allow()
	}
}

// handleHeartbeat resets the read deadline and acks the client's heartbeat.
func (c *Client) handleHeartbeat(_ Event) {
	if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		log.Printf("[ws] failed to set read deadline for user %s: %v", c.userID, err)
		return
	}
	c.sendEvent(Event{Op: OpHeartbeatAck})
}

// handlePresenceUpdate processes a client presence change.
// Updates per-connection status, computes aggregate across all connections,
// then delegates DB persist + broadcast to the callback.
func (c *Client) handlePresenceUpdate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data PresenceData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	switch data.Status {
	case "online", "idle", "dnd", "offline":
		// valid
	default:
		log.Printf("[ws] invalid presence status from user %s: %s", c.userID, data.Status)
		return
	}

	c.hub.mu.Lock()
	c.status = data.Status
	aggregate := c.hub.computeAggregateStatusLocked(c.userID)
	c.hub.mu.Unlock()

	if c.hub.onPresenceManualUpdate != nil {
		c.hub.onPresenceManualUpdate(c.userID, aggregate, data.IsAuto)
	}
}

// handleTyping validates channel access and broadcasts a typing indicator
// to the channel's server members only. Uses a callback to avoid Hub
// depending on channel/permission services directly (same pattern as DM typing).
func (c *Client) handleTyping(event Event) {
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

	if c.hub.onChannelTyping != nil {
		username := c.hub.getUserUsername(c.userID)
		c.hub.onChannelTyping(c.userID, username, typing.ChannelID)
	}
}

// handleDMTyping broadcasts a DM typing indicator to the other participant only.
// Uses a callback to avoid Hub depending on DM repo directly.
func (c *Client) handleDMTyping(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data struct {
		DMChannelID string `json:"dm_channel_id"`
	}
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.DMChannelID == "" {
		return
	}

	if c.hub.onDMTyping != nil {
		username := c.hub.getUserUsername(c.userID)
		c.hub.onDMTyping(c.userID, username, data.DMChannelID)
	}
}

// ─── Voice Event Handlers ───

func (c *Client) handleVoiceJoin(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceJoinData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.ChannelID == "" {
		log.Printf("[ws] voice_join without channel_id from user %s", c.userID)
		return
	}

	// Note: no voice_replaced broadcast here. Real multi-session handover is
	// already signaled by the SFU's DUPLICATE_IDENTITY disconnect on the
	// superseded session; adding a WS broadcast caused a ghost-pointer race
	// (stale Client struct in the hub map received the event after reconnect,
	// disconnecting the live session). Client handles DUPLICATE_IDENTITY
	// directly in VoiceProvider.handleDisconnected.

	if c.hub.onVoiceJoin != nil {
		info := c.hub.getUserInfo(c.userID)
		c.hub.onVoiceJoin(c.userID, info.Username, info.DisplayName, info.AvatarURL, data.ChannelID, data.IsMuted, data.IsDeafened)
	}
}

func (c *Client) handleVoiceLeave() {
	if c.hub.onVoiceLeave != nil {
		c.hub.onVoiceLeave(c.userID)
	}
}

func (c *Client) handleVoiceActivity() {
	if c.hub.onVoiceActivity != nil {
		c.hub.onVoiceActivity(c.userID)
	}
}

func (c *Client) handleVoiceStateUpdate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceStateUpdateRequestData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if c.hub.onVoiceStateUpdate != nil {
		c.hub.onVoiceStateUpdate(c.userID, data.IsMuted, data.IsDeafened, data.IsStreaming)
	}
}

func (c *Client) handleVoiceAdminStateUpdate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceAdminStateUpdateData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.TargetUserID == "" {
		log.Printf("[ws] voice_admin_state_update missing target_user_id from user %s", c.userID)
		return
	}

	if c.hub.onVoiceAdminStateUpdate != nil {
		c.hub.onVoiceAdminStateUpdate(c.userID, data.TargetUserID, data.IsServerMuted, data.IsServerDeafened)
	}
}

func (c *Client) handleVoiceMoveUser(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceMoveUserData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.TargetUserID == "" || data.TargetChannelID == "" {
		log.Printf("[ws] voice_move_user missing fields from user %s", c.userID)
		return
	}

	if c.hub.onVoiceMoveUser != nil {
		c.hub.onVoiceMoveUser(c.userID, data.TargetUserID, data.TargetChannelID)
	}
}

func (c *Client) handleVoiceDisconnectUser(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceDisconnectUserData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.TargetUserID == "" {
		log.Printf("[ws] voice_disconnect_user missing target_user_id from user %s", c.userID)
		return
	}

	if c.hub.onVoiceDisconnectUser != nil {
		c.hub.onVoiceDisconnectUser(c.userID, data.TargetUserID)
	}
}

func (c *Client) handleScreenShareWatch(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data ScreenShareWatchData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.StreamerUserID == "" {
		log.Printf("[ws] screen_share_watch missing streamer_user_id from user %s", c.userID)
		return
	}

	if c.hub.onScreenShareWatch != nil {
		c.hub.onScreenShareWatch(c.userID, data.StreamerUserID, data.Watching)
	}
}

// ─── P2P Call Event Handlers ───

func (c *Client) handleP2PCallInitiate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data P2PCallInitiateData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.ReceiverID == "" || data.CallType == "" {
		log.Printf("[ws] p2p_call_initiate missing fields from user %s", c.userID)
		return
	}

	if c.hub.onP2PCallInitiate != nil {
		c.hub.onP2PCallInitiate(c.userID, c.sessionID, data)
	}
}

func (c *Client) handleP2PCallAccept(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data P2PCallAcceptData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.CallID == "" {
		log.Printf("[ws] p2p_call_accept missing call_id from user %s", c.userID)
		return
	}

	if c.hub.onP2PCallAccept != nil {
		c.hub.onP2PCallAccept(c.userID, c.sessionID, c.deviceID, data)
	}
}

func (c *Client) handleP2PCallDecline(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data P2PCallDeclineData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.CallID == "" {
		log.Printf("[ws] p2p_call_decline missing call_id from user %s", c.userID)
		return
	}

	if c.hub.onP2PCallDecline != nil {
		c.hub.onP2PCallDecline(c.userID, c.deviceID, data)
	}
}

// handleP2PCallEnd hangs up. call_id is optional (an old client sends none), but when present
// the server checks it names the call the user is actually in — a late "end" from a sibling
// device or the 30s outgoing timeout would otherwise kill whatever call they started since.
func (c *Client) handleP2PCallEnd(event Event) {
	var data P2PCallEndData
	if event.Data != nil {
		if raw, err := json.Marshal(event.Data); err == nil {
			_ = json.Unmarshal(raw, &data)
		}
	}
	if c.hub.onP2PCallEnd != nil {
		c.hub.onP2PCallEnd(c.userID, c.deviceID, data.CallID)
	}
}

// handleP2PCallResume — this connection replaced the one that was carrying the call.
func (c *Client) handleP2PCallResume(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}
	var data P2PCallResumeData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}
	if data.CallID == "" {
		return
	}
	if c.hub.onP2PCallResume != nil {
		c.hub.onP2PCallResume(c.userID, c.sessionID, data.CallID)
	}
}

// handleP2PSignal relays WebRTC SDP/ICE data to the other peer.
func (c *Client) handleP2PSignal(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data P2PSignalData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.CallID == "" || data.Type == "" {
		log.Printf("[ws] p2p_signal missing fields from user %s", c.userID)
		return
	}

	if c.hub.onP2PSignal != nil {
		c.hub.onP2PSignal(c.userID, c.sessionID, data)
	}
}

// markClosed signals the client is being torn down. Idempotent — safe to call from
// removeClient and Shutdown, and to call twice. Never closes the send channel.
func (c *Client) markClosed() {
	c.closeOnce.Do(func() { close(c.done) })
}

// trySend enqueues data without ever sending on a closed channel (send is never closed).
// Returns false only when the buffer is full and the client is still open — the caller
// should then drop the connection. A client already being torn down returns true (no-op).
func (c *Client) trySend(data []byte) bool {
	select {
	case <-c.done:
		return true
	default:
	}
	select {
	case c.send <- data:
		return true
	case <-c.done:
		return true
	default:
		return false
	}
}

func (c *Client) sendEvent(event Event) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal event for user %s: %v", c.userID, err)
		return
	}

	if !c.trySend(data) {
		log.Printf("[ws] send buffer full for user %s, dropping connection", c.userID)
		c.hub.unregister <- c
	}
}

// WritePump writes messages from Hub to the WebSocket connection.
// Runs as a goroutine until the send channel is closed.
func (c *Client) WritePump() {
	defer c.conn.Close()

	for {
		select {
		case message := <-c.send:
			if err := c.writeMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-c.done:
			// Hub removed this client — send a close frame and exit.
			c.writeMessage(websocket.CloseMessage, nil)
			return
		}
	}
}

// writeMessage writes to the WebSocket connection under mutex.
// gorilla/websocket does not support concurrent writes.
func (c *Client) writeMessage(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		return err
	}
	return c.conn.WriteMessage(messageType, data)
}
