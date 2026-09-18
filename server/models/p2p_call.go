package models

import "time"

type P2PCallType string

const (
	P2PCallTypeVoice P2PCallType = "voice"
	P2PCallTypeVideo P2PCallType = "video"
)

type P2PCallStatus string

const (
	P2PCallStatusRinging P2PCallStatus = "ringing"
	P2PCallStatusActive  P2PCallStatus = "active"
	P2PCallStatusEnded   P2PCallStatus = "ended"
)

// P2PCall — ephemeral, in-memory only (no DB persistence).
// Cleared on server restart.
type P2PCall struct {
	ID         string        `json:"id"`
	CallerID   string        `json:"caller_id"`
	ReceiverID string        `json:"receiver_id"`
	CallType   P2PCallType   `json:"call_type"`
	Status     P2PCallStatus `json:"status"`
	CreatedAt  time.Time     `json:"created_at"`
	AcceptedAt time.Time     `json:"accepted_at,omitempty"` // set when answered; basis for call duration

	// A call is owned by two connections, not two users. ReceiverSessionID stays empty until an
	// accept, while every device of the receiver still rings.
	CallerSessionID   string `json:"-"`
	ReceiverSessionID string `json:"-"`

	// The running app behind each side (per page load); only it may take its call back.
	CallerInstanceID   string `json:"-"`
	ReceiverInstanceID string `json:"-"`
	// The installation behind each side, to tell an app this device restarted from a live one.
	CallerDeviceID   string `json:"-"`
	ReceiverDeviceID string `json:"-"`

	// A cancel push for a ring that never went out shows iOS a phantom call.
	RingPushed bool `json:"-"`
}

// P2PCallBroadcast — broadcast payload carrying both caller and receiver info.
type P2PCallBroadcast struct {
	ID                  string        `json:"id"`
	CallerID            string        `json:"caller_id"`
	CallerUsername      string        `json:"caller_username"`
	CallerDisplayName   *string       `json:"caller_display_name"`
	CallerAvatarURL     *string       `json:"caller_avatar"`
	ReceiverID          string        `json:"receiver_id"`
	ReceiverUsername     string        `json:"receiver_username"`
	ReceiverDisplayName *string       `json:"receiver_display_name"`
	ReceiverAvatarURL   *string       `json:"receiver_avatar"`
	CallType            P2PCallType   `json:"call_type"`
	Status              P2PCallStatus `json:"status"`
	CreatedAt           time.Time     `json:"created_at"`

	// InitiatedBy names the caller's connection that placed the call. Sent ONLY to the caller's
	// own sessions: the others must recognise the outgoing call as not theirs and ignore it,
	// instead of opening a microphone and negotiating a second, competing WebRTC session.
	// Empty on the receiver's copy, and on any event from a server that predates this.
	InitiatedBy string `json:"initiated_by,omitempty"`
	// InitiatedByInstance names the running app that dialled. Unlike the session it survives a
	// reconnect, so the app still recognises its own call if the broadcast lands on a new socket.
	InitiatedByInstance string `json:"initiated_by_instance,omitempty"`
}

// P2PSignalPayload — WebRTC signaling data (SDP offer/answer or ICE candidate).
type P2PSignalPayload struct {
	CallID    string `json:"call_id"`
	Type      string `json:"type"`              // "offer", "answer", "ice-candidate"
	SDP       string `json:"sdp,omitempty"`
	Candidate any    `json:"candidate,omitempty"` // RTCIceCandidateInit
}
