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

// ScreenShareFallbackRequest is the client saying "the native helper could not start, I used the
// browser engine instead" — the one failure the operator cannot see from the server, because every
// step that fails happens on the user's machine.
type ScreenShareFallbackRequest struct {
	ChannelID string `json:"channel_id"`
	// Engine is which helper engine was attempted, from ScreenShareFallbackEngines. Empty means
	// smooth: clients that predate the field only ever had that one.
	Engine string `json:"engine,omitempty"`
	// Reason is a code from ScreenShareFallbackReasons, not free text: it lands in app_logs, so an
	// unvalidated string would let any member write whatever they like into the operator's log.
	Reason string `json:"reason"`
	// Detail is the underlying error, kept for diagnosis and truncated by the handler. Never
	// interpreted, only stored.
	Detail string `json:"detail,omitempty"`
}

// ScreenShareFallbackReasons is the closed set the client may report. Anything else is rejected
// rather than stored, so the log stays scannable by cause.
//
// There is deliberately no "unsupported": smooth capture is only offered where it can run, so a
// platform that cannot do it never reports a fallback — it never attempted one.
var ScreenShareFallbackReasons = map[string]bool{
	"no_token":      true, // the screen-token request was refused or carried no passphrase
	"helper_failed": true, // the native helper never reported that it was publishing
}

// ScreenShareFallbackEngines is the closed set of helper engines a fallback can come from.
var ScreenShareFallbackEngines = map[string]bool{
	"smooth":    true, // "Smooth Video": hardware H264/H265
	"sharp_hdr": true, // "Sharp Video" on an HDR display: software VP9 after tone-mapping
}

// ScreenShareStopRequest is the client saying a share ended without the user pressing stop. Like the
// fallback above, everything that ends it happens on the user's machine, so without this report
// nothing reaches the server at all.
type ScreenShareStopRequest struct {
	ChannelID string `json:"channel_id"`
	// Engine is which engine carried the share, from ScreenShareStopEngines. Empty means browser:
	// clients that predate the field only reported the browser engine.
	Engine string `json:"engine,omitempty"`
	// Reason is a code from ScreenShareStopReasons; the same closed-set rule as the fallback.
	Reason string `json:"reason"`
	// AliveMs is how long the share ran before it ended — a share that dies within a second of
	// starting is the reported bug, one that ends after an hour is a closed window.
	AliveMs int64 `json:"alive_ms"`
	// Detail is the underlying error for start_failed, truncated by the handler.
	Detail string `json:"detail,omitempty"`
}

// ScreenShareStopReasons is the closed set of ways a share can end without the stop button.
var ScreenShareStopReasons = map[string]bool{
	"start_failed":  true, // publishing the share threw (capture refused, picker failed, SDK error)
	"track_ended":   true, // the captured source ended: window closed, OS "stop sharing", game exited
	"unpublished":   true, // LiveKit unpublished the track: reconnect, SFU drop
	"helper_exited": true, // the native helper died mid-share: encoder failure, crash, room dropped
}

// ScreenShareStopEngines is the closed set of engines a stop report can name.
var ScreenShareStopEngines = map[string]bool{
	"browser":   true, // getDisplayMedia — "Sharp Video" on an SDR display
	"smooth":    true, // the helper's hardware engine — "Smooth Video"
	"sharp_hdr": true, // the helper's tone-mapping VP9 engine — "Sharp Video" on an HDR display
	"mobile":    true, // the phone's native capture (ReplayKit / MediaProjection)
}

// ScreenShareShortLivedMs splits a share that ended with its source into the reported bug (it ends
// within seconds of starting) and someone closing what they were sharing. Only the first is a
// failure; the second is recorded at Info so the Warn rows stay the ones worth reading.
const ScreenShareShortLivedMs = 10_000

// ScreenShareFallbackDetailMax is how much of Detail survives: long enough for a helper error,
// short enough that a member cannot use the field as storage.
const ScreenShareFallbackDetailMax = 200

// VoiceReportBodyMax caps the body of the client reports (screen-share fallback and stop, noise
// reduction failure). Their fields are bounded after decoding, but the decoder reads the whole body
// first; an honest report is a few hundred bytes, so this leaves ample room and nothing more.
const VoiceReportBodyMax = 4 << 10

// ScreenShareChannelIDMax bounds the other field a member controls. Channel ids are 16 hex chars
// (`lower(hex(randomblob(8)))`); this is generous room around that, and the point is only that the
// value cannot be unbounded — it lands in app_logs metadata, and nothing else caps a JSON body.
const ScreenShareChannelIDMax = 64

// NoiseReductionFailureRequest is the client saying "the mic denoiser did not attach".
//
// Same blind spot as the screen-share fallback and worse in one way: a share that fails is visible
// to the person sharing, whereas a denoiser that never attached is not visible to anyone. The user
// simply sounds noisy and assumes the feature is weak. Until this existed the only record was a
// console.error nobody reads in a packaged app.
type NoiseReductionFailureRequest struct {
	ChannelID string `json:"channel_id"`
	// Engine is which denoiser was being attached, from NoiseReductionEngines.
	Engine string `json:"engine"`
	// Reason is a code from NoiseReductionFailureReasons, not free text — it lands in app_logs.
	Reason string `json:"reason"`
	// Detail is the underlying error, kept for diagnosis and truncated by the handler. Never
	// interpreted, only stored.
	Detail string `json:"detail,omitempty"`
}

// NoiseReductionEngines is the closed set of denoisers the client may name.
var NoiseReductionEngines = map[string]bool{
	"rnnoise": true, // "Standard" — RNNoise, full-band
	"gtcrn":   true, // "Strong" — GTCRN, 16 kHz model
	"vadgate": true, // no denoising, sensitivity gate only
}

// NoiseReductionFailureReasons is the closed set of causes, so the category stays scannable.
var NoiseReductionFailureReasons = map[string]bool{
	// The device's audio rate is one GTCRN cannot run; the client dropped to "Standard" and said so.
	"unsupported_sample_rate": true,
	// Anything else thrown while attaching. The user has no denoising at all and was not told.
	"attach_failed": true,
}

// MicHealthReport is the client saying its microphone should be sending and is not ("dead"), and
// later how that ended ("recovered", or "left_voice" when the user left still dead).
//
// Every way a mic dies happens on the user's machine — the capture track ends, the OS suspends it,
// the SDK mutes it after a failed restart, an audio context is suspended — and none of it reaches
// the server: the user simply cannot be heard. Each field is a code from a closed set so the rows
// can be scanned and grouped by cause.
type MicHealthReport struct {
	ChannelID string `json:"channel_id"`
	// Event is "dead", "recovered" or "left_voice" (MicHealthEvents).
	Event string `json:"event"`
	// Fault is the cause the client saw when it declared the mic dead (MicFaults); the same code is
	// repeated on the closing report so the pair reads together.
	Fault string `json:"fault"`
	// Faults is every cause seen during the episode, in order — a mic can go os_muted and then
	// upstream_paused as the SDK reacts.
	Faults []string `json:"faults,omitempty"`
	// Intent is what the mic should be doing: "live" (voice activity, unmuted) or "ptt" (push to
	// talk, between presses) — PTT is judged on capture faults only.
	Intent    string `json:"intent"`
	Platform  string `json:"platform"`
	Processor string `json:"processor"`
	// AppVersion is the client build; shape-checked, not trusted.
	AppVersion string `json:"app_version,omitempty"`
	// DurationMs is how long the mic had been faulty when the report was sent: the open threshold on
	// "dead", the whole episode on the closing reports.
	DurationMs int64 `json:"duration_ms"`
	// SinceReconnectMs is how long before the fault began the last LiveKit reconnect completed, or -1
	// if there was none this session.
	SinceReconnectMs int64 `json:"since_reconnect_ms"`
	// Trail is the recent mic and connection events, oldest first.
	Trail []MicTrailEntry `json:"trail,omitempty"`
	// Detail is the last media-device error message the SDK raised, if any. Truncated by the handler.
	Detail string `json:"detail,omitempty"`
}

// MicTrailEntry is one event and how long before the report it happened.
type MicTrailEntry struct {
	Event string `json:"e"`
	AgoMs int64  `json:"ago_ms"`
}

// MicHealthEvents is the closed set of report kinds.
var MicHealthEvents = map[string]bool{"dead": true, "recovered": true, "left_voice": true}

// MicFaults is the closed set of reasons a mic is judged dead.
var MicFaults = map[string]bool{
	"no_publication":          true, // should be live, nothing is published
	"track_ended":             true, // the capture track ended (device lost, OS revoked it)
	"sdk_muted":               true, // the SDK muted the track itself (failed restart), the user did not
	"upstream_paused":         true, // the SDK stopped sending after the OS muted capture for 5 s
	"os_muted":                true, // the OS muted the capture track (screen lock, sleep, device busy)
	"track_disabled":          true, // the track is disabled while the user is unmuted
	"audio_context_suspended": true, // the noise-reduction / gate processor's audio context is not running
	"processed_track_ended":   true, // the processor's output track ended
}

// MicIntents is the closed set of what the mic should be doing.
var MicIntents = map[string]bool{"live": true, "ptt": true}

// MicPlatforms is the closed set of client platforms that report. The iOS app is absent: its voice
// runs in the native SDK, not this code.
var MicPlatforms = map[string]bool{
	"electron_mac": true, "electron_windows": true, "electron_linux": true, "web": true, "android": true,
}

// MicProcessors is the closed set of processors on the mic.
var MicProcessors = map[string]bool{"none": true, "rnnoise": true, "gtcrn": true, "vadgate": true}

// MicTrailEvents is the closed set of events a trail may carry.
var MicTrailEvents = map[string]bool{
	// connection
	"reconnecting": true, "signal_reconnecting": true, "reconnected": true, "disconnected": true,
	// the mic track
	"track_ended": true, "track_restarted": true, "sdk_muted": true, "sdk_unmuted": true,
	"os_muted": true, "os_unmuted": true, "upstream_paused": true, "upstream_resumed": true,
	"mic_published": true, "mic_unpublished": true, "device_error": true,
	// the machine
	"device_change": true, "ctx_suspended": true, "ctx_running": true, "ctx_interrupted": true, "ctx_closed": true,
	"page_hidden": true, "page_visible": true, "screen_locked": true, "screen_unlocked": true,
	"system_suspend": true, "system_resume": true,
	// the user
	"user_muted": true, "user_unmuted": true, "ptt_down": true, "ptt_up": true,
}

// MicTrailMax bounds the trail; MicAppVersionMax the version string.
const (
	MicTrailMax      = 24
	MicAppVersionMax = 32
)
