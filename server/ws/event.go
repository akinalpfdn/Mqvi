package ws

// Event is the WebSocket message format.
// Seq is a monotonic counter for gap detection on the client side.
type Event struct {
	Op   string `json:"op"`
	Data any    `json:"d,omitempty"`
	Seq  int64  `json:"seq,omitempty"`
}

// ─── Operation Constants ───

// Client -> Server
const (
	OpHeartbeat      = "heartbeat"
	OpTyping         = "typing"
	OpPresenceUpdate = "presence_update"
)

// Server -> Client
const (
	OpReady         = "ready"
	OpHeartbeatAck  = "heartbeat_ack"
	OpMessageCreate = "message_create"
	OpMessageUpdate = "message_update"
	OpMessageDelete = "message_delete"
	OpChannelCreate  = "channel_create"
	OpChannelUpdate  = "channel_update"
	OpChannelDelete  = "channel_delete"
	OpCategoryCreate = "category_create"
	OpCategoryUpdate = "category_update"
	OpCategoryDelete = "category_delete"
	OpTypingStart    = "typing_start"
	OpPresence      = "presence_update"
	OpMemberJoin    = "member_join"
	OpMemberLeave   = "member_leave"
	OpMemberUpdate  = "member_update"
	OpRoleCreate    = "role_create"
	OpRoleUpdate    = "role_update"
	OpRoleDelete    = "role_delete"
	OpRolesReorder  = "roles_reorder"
	OpServerUpdate = "server_update"
	OpServerCreate = "server_create"
	OpServerDelete = "server_delete"

	OpMessagePin   = "message_pin"
	OpMessageUnpin = "message_unpin"

	OpReactionUpdate = "reaction_update"

	OpChannelPermissionUpdate = "channel_permission_update"
	OpChannelPermissionDelete = "channel_permission_delete"

	OpChannelReorder  = "channel_reorder"
	OpCategoryReorder = "category_reorder"

	// DM operations
	OpDMChannelCreate  = "dm_channel_create"
	OpDMMessageCreate  = "dm_message_create"
	OpDMMessageUpdate  = "dm_message_update"
	OpDMMessageDelete  = "dm_message_delete"
	OpDMReactionUpdate = "dm_reaction_update"
	OpDMTypingStart    = "dm_typing_start"
	OpDMMessagePin     = "dm_message_pin"
	OpDMMessageUnpin   = "dm_message_unpin"
	OpDMSettingsUpdate = "dm_settings_update"

	// Block operations
	OpUserBlock   = "user_block"
	OpUserUnblock = "user_unblock"

	// Voice operations
	OpVoiceStateUpdate = "voice_state_update"
	OpVoiceStatesSync  = "voice_states_sync"

	// Friend operations
	OpFriendRequestCreate  = "friend_request_create"
	OpFriendRequestAccept  = "friend_request_accept"
	OpFriendRequestDecline = "friend_request_decline"
	OpFriendRemove         = "friend_remove"
)

// Client -> Server voice operations
const (
	OpVoiceJoin             = "voice_join"
	OpVoiceLeave            = "voice_leave"
	OpVoiceStateUpdateReq   = "voice_state_update_request"
	OpVoiceAdminStateUpdate = "voice_admin_state_update"
	OpVoiceMoveUser        = "voice_move_user"
	OpVoiceDisconnectUser  = "voice_disconnect_user"
)

// Server -> Client voice moderation
const (
	OpVoiceForceMove       = "voice_force_move"
	OpVoiceForceDisconnect = "voice_force_disconnect"
)

// P2P Call signaling flow:
// 1. Caller: p2p_call_initiate -> Server validate -> Receiver: p2p_call_initiate
// 2. Receiver: p2p_call_accept -> Server update -> Caller: p2p_call_accept
// 3. WebRTC negotiation: p2p_signal relay (SDP offer/answer/ICE candidates)
// 4. Either: p2p_call_end -> Server cleanup -> Other: p2p_call_end
const (
	OpP2PCallInitiate = "p2p_call_initiate"
	OpP2PCallAccept   = "p2p_call_accept"
	OpP2PCallDecline  = "p2p_call_decline"
	OpP2PCallEnd      = "p2p_call_end"
	OpP2PSignal       = "p2p_signal"
	OpP2PCallBusy     = "p2p_call_busy"
)

// E2EE operations
const (
	OpDeviceKeyChange  = "device_key_change"
	OpPrekeyLow        = "prekey_low"
	OpGroupSessionNew  = "group_session_new"
	OpDeviceListUpdate = "device_list_update"
)

// ReadyData is the payload sent to a client on initial connection.
type ReadyData struct {
	OnlineUserIDs   []string          `json:"online_user_ids"`
	Servers         []ReadyServerItem `json:"servers"`
	MutedServerIDs  []string          `json:"muted_server_ids"`
	MutedChannelIDs []string          `json:"muted_channel_ids"`
}

// ReadyServerItem is a minimal server representation for the ready event.
// Separate from models to avoid ws -> models coupling.
type ReadyServerItem struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	IconURL *string `json:"icon_url"`
}

type PresenceData struct {
	UserID string `json:"user_id"`
	Status string `json:"status"`
}

type TypingData struct {
	ChannelID string `json:"channel_id"`
}

type TypingStartData struct {
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
	ChannelID string `json:"channel_id"`
}

type DMTypingStartData struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	DMChannelID string `json:"dm_channel_id"`
}

// ─── Voice Event Data ───

type VoiceJoinData struct {
	ChannelID string `json:"channel_id"`
}

// VoiceStateUpdateRequestData — nil pointer = no change (partial update).
type VoiceStateUpdateRequestData struct {
	IsMuted    *bool `json:"is_muted,omitempty"`
	IsDeafened *bool `json:"is_deafened,omitempty"`
	IsStreaming *bool `json:"is_streaming,omitempty"`
}

// VoiceAdminStateUpdateData — admin server mute/deafen request.
type VoiceAdminStateUpdateData struct {
	TargetUserID     string `json:"target_user_id"`
	IsServerMuted    *bool  `json:"is_server_muted,omitempty"`
	IsServerDeafened *bool  `json:"is_server_deafened,omitempty"`
}

type VoiceMoveUserData struct {
	TargetUserID    string `json:"target_user_id"`
	TargetChannelID string `json:"target_channel_id"`
}

type VoiceDisconnectUserData struct {
	TargetUserID string `json:"target_user_id"`
}

// VoiceForceMoveData — server tells client to switch to a different channel.
type VoiceForceMoveData struct {
	ChannelID string `json:"channel_id"`
}

// VoiceStateUpdateBroadcast — broadcast payload when a user's voice state changes.
type VoiceStateUpdateBroadcast struct {
	UserID           string `json:"user_id"`
	ChannelID        string `json:"channel_id"`
	Username         string `json:"username"`
	DisplayName      string `json:"display_name"`
	AvatarURL        string `json:"avatar_url"`
	IsMuted          bool   `json:"is_muted"`
	IsDeafened       bool   `json:"is_deafened"`
	IsStreaming      bool   `json:"is_streaming"`
	IsServerMuted    bool   `json:"is_server_muted"`
	IsServerDeafened bool   `json:"is_server_deafened"`
	Action           string `json:"action"` // "join", "leave", "update"
}

// VoiceStatesSyncData — bulk voice state sync sent on connection.
type VoiceStatesSyncData struct {
	States []VoiceStateItem `json:"states"`
}

// VoiceStateItem mirrors models.VoiceState without creating a ws -> models dependency.
type VoiceStateItem struct {
	UserID           string `json:"user_id"`
	ChannelID        string `json:"channel_id"`
	Username         string `json:"username"`
	DisplayName      string `json:"display_name"`
	AvatarURL        string `json:"avatar_url"`
	IsMuted          bool   `json:"is_muted"`
	IsDeafened       bool   `json:"is_deafened"`
	IsStreaming      bool   `json:"is_streaming"`
	IsServerMuted    bool   `json:"is_server_muted"`
	IsServerDeafened bool   `json:"is_server_deafened"`
}

// ─── P2P Call Event Data ───

type P2PCallInitiateData struct {
	ReceiverID string `json:"receiver_id"`
	CallType   string `json:"call_type"` // "voice" or "video"
}

type P2PCallAcceptData struct {
	CallID string `json:"call_id"`
}

type P2PCallDeclineData struct {
	CallID string `json:"call_id"`
}

// P2PSignalData carries WebRTC SDP/ICE data. Server relays without inspecting.
type P2PSignalData struct {
	CallID    string `json:"call_id"`
	Type      string `json:"type"`                // "offer", "answer", "ice-candidate"
	SDP       string `json:"sdp,omitempty"`
	Candidate any    `json:"candidate,omitempty"`
}
