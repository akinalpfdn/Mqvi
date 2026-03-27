package ws

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 90 * time.Second  // 3 missed heartbeats (30s × 3)
	maxMessageSize = 32768             // 32KB — WebRTC SDP + E2EE base64 overhead
	sendBufferSize = 256
)

// Client represents a single WebSocket connection.
// Each connection runs two goroutines: ReadPump (read) and WritePump (write).
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	userID string
	send   chan []byte
	mu     sync.Mutex // protects conn.WriteMessage

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
			log.Printf("[ws] invalid message from user %s: %v", c.userID, err)
			continue
		}

		c.handleEvent(event)
	}
}

// handleEvent dispatches an incoming event by operation type.
func (c *Client) handleEvent(event Event) {
	switch event.Op {
	case OpHeartbeat:
		if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
			log.Printf("[ws] failed to set read deadline for user %s: %v", c.userID, err)
			return
		}
		c.sendEvent(Event{Op: OpHeartbeatAck})

	case OpTyping:
		c.handleTyping(event)
	case OpPresenceUpdate:
		c.handlePresenceUpdate(event)
	case OpVoiceJoin:
		c.handleVoiceJoin(event)
	case OpVoiceLeave:
		c.handleVoiceLeave()
	case OpVoiceStateUpdateReq:
		c.handleVoiceStateUpdate(event)
	case OpVoiceAdminStateUpdate:
		c.handleVoiceAdminStateUpdate(event)
	case OpVoiceMoveUser:
		c.handleVoiceMoveUser(event)
	case OpVoiceDisconnectUser:
		c.handleVoiceDisconnectUser(event)
	case OpScreenShareWatch:
		c.handleScreenShareWatch(event)
	case OpVoiceActivity:
		c.handleVoiceActivity()
	case OpDMTypingStart:
		c.handleDMTyping(event)
	case OpP2PCallInitiate:
		c.handleP2PCallInitiate(event)
	case OpP2PCallAccept:
		c.handleP2PCallAccept(event)
	case OpP2PCallDecline:
		c.handleP2PCallDecline(event)
	case OpP2PCallEnd:
		c.handleP2PCallEnd()
	case OpP2PSignal:
		c.handleP2PSignal(event)

	default:
		log.Printf("[ws] unknown op from user %s: %s", c.userID, event.Op)
	}
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
		go c.hub.onPresenceManualUpdate(c.userID, aggregate, data.IsAuto)
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
		go c.hub.onChannelTyping(c.userID, username, typing.ChannelID)
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
		go c.hub.onDMTyping(c.userID, username, data.DMChannelID)
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

	// Notify other sessions of same user: "voice replaced by another session"
	// Prevents auto-rejoin ping-pong when same account joins from multiple tabs
	c.hub.broadcastToUserExcept(c.userID, c, Event{Op: OpVoiceReplaced})

	if c.hub.onVoiceJoin != nil {
		info := c.hub.getUserInfo(c.userID)
		go c.hub.onVoiceJoin(c.userID, info.Username, info.DisplayName, info.AvatarURL, data.ChannelID)
	}
}

func (c *Client) handleVoiceLeave() {
	if c.hub.onVoiceLeave != nil {
		go c.hub.onVoiceLeave(c.userID)
	}
}

func (c *Client) handleVoiceActivity() {
	if c.hub.onVoiceActivity != nil {
		go c.hub.onVoiceActivity(c.userID)
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
		go c.hub.onVoiceStateUpdate(c.userID, data.IsMuted, data.IsDeafened, data.IsStreaming)
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
		go c.hub.onVoiceAdminStateUpdate(c.userID, data.TargetUserID, data.IsServerMuted, data.IsServerDeafened)
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
		go c.hub.onVoiceMoveUser(c.userID, data.TargetUserID, data.TargetChannelID)
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
		go c.hub.onVoiceDisconnectUser(c.userID, data.TargetUserID)
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
		go c.hub.onScreenShareWatch(c.userID, data.StreamerUserID, data.Watching)
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
		go c.hub.onP2PCallInitiate(c.userID, data)
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
		go c.hub.onP2PCallAccept(c.userID, data)
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
		go c.hub.onP2PCallDecline(c.userID, data)
	}
}

// handleP2PCallEnd — no payload needed, userID identifies the active call.
func (c *Client) handleP2PCallEnd() {
	if c.hub.onP2PCallEnd != nil {
		go c.hub.onP2PCallEnd(c.userID)
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
		go c.hub.onP2PSignal(c.userID, data)
	}
}

func (c *Client) sendEvent(event Event) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal event for user %s: %v", c.userID, err)
		return
	}

	select {
	case c.send <- data:
	default:
		log.Printf("[ws] send buffer full for user %s, dropping connection", c.userID)
		c.hub.unregister <- c
	}
}

// WritePump writes messages from Hub to the WebSocket connection.
// Runs as a goroutine until the send channel is closed.
func (c *Client) WritePump() {
	defer c.conn.Close()

	for {
		message, ok := <-c.send
		if !ok {
			// Channel closed — Hub removed this client
			c.writeMessage(websocket.CloseMessage, nil)
			return
		}

		if err := c.writeMessage(websocket.TextMessage, message); err != nil {
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
