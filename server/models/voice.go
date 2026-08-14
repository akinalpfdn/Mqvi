package models

import "time"

// VoiceState is ephemeral — stored in-memory only, not in DB.
// Resets on server restart (all WS connections drop anyway).
type VoiceState struct {
	UserID      string `json:"user_id"`
	ChannelID   string `json:"channel_id"`
	ChannelName string `json:"channel_name"` // cached for cross-server voice presence popups
	ServerID    string `json:"server_id"`    // parent server — used to scope WS broadcasts
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
	IsMuted     bool   `json:"is_muted"`
	IsDeafened  bool   `json:"is_deafened"`
	IsStreaming bool   `json:"is_streaming"`
	// ShareQuality is the ceiling the sharer picked ("720p"/"1080p"), not what is being sent —
	// the stream follows the shared window's own size under it. Empty when not sharing.
	ShareQuality     string    `json:"share_quality,omitempty"`
	IsServerMuted    bool      `json:"is_server_muted"`
	IsServerDeafened bool      `json:"is_server_deafened"`
	LastActivity     time.Time `json:"-"` // not serialized — server-side AFK tracking only
}

type VoiceTokenRequest struct {
	ChannelID string `json:"channel_id"`
}

type VoiceTokenResponse struct {
	Token          string `json:"token"`
	URL            string `json:"url"`
	ChannelID      string `json:"channel_id"`
	E2EEPassphrase string `json:"e2ee_passphrase,omitempty"`
}

// ScreenShareFallbackRequest is the client saying "Akıcı Görüntü could not start, I used Net
// Görüntü instead" — the one failure the operator cannot see from the server, because every step
// that fails happens on the user's machine.
type ScreenShareFallbackRequest struct {
	ChannelID string `json:"channel_id"`
	// Reason is a code from ScreenShareFallbackReasons, not free text: it lands in app_logs, so an
	// unvalidated string would let any member write whatever they like into the operator's log.
	Reason string `json:"reason"`
	// Detail is the underlying error, kept for diagnosis and truncated by the handler. Never
	// interpreted, only stored.
	Detail string `json:"detail,omitempty"`
}

// ScreenShareFallbackReasons is the closed set the client may report. Anything else is rejected
// rather than stored, so the log stays scannable by cause.
var ScreenShareFallbackReasons = map[string]bool{
	"no_token":      true, // the screen-token request was refused or carried no passphrase
	"helper_failed": true, // the native helper never reported that it was publishing
	"unsupported":   true, // not Windows, or no Electron bridge — smooth cannot run at all here
}

// ScreenShareFallbackDetailMax is how much of Detail survives: long enough for a helper error,
// short enough that a member cannot use the field as storage.
const ScreenShareFallbackDetailMax = 200
