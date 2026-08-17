package models

// LogLevel represents severity of a log entry.
type LogLevel string

const (
	LogLevelError LogLevel = "error"
	LogLevelWarn  LogLevel = "warn"
	LogLevelInfo  LogLevel = "info"
)

// LogCategory represents the subsystem that produced the log.
type LogCategory string

const (
	LogCategoryVoice       LogCategory = "voice"
	LogCategoryVideo       LogCategory = "video"
	LogCategoryScreenShare LogCategory = "screen_share"
	// LogCategoryNoiseReduction covers the mic denoiser failing to attach — invisible otherwise,
	// because the user just sounds noisy and nothing on the server ever hears about it.
	LogCategoryNoiseReduction LogCategory = "noise_reduction"
	LogCategoryWS          LogCategory = "ws"
	LogCategoryAuth        LogCategory = "auth"
	LogCategoryGeneral     LogCategory = "general"
	LogCategoryFeedback    LogCategory = "feedback"
	LogCategoryLiveKit     LogCategory = "livekit"
	LogCategoryCleaner     LogCategory = "cleaner"
)

// AppLog represents a structured log entry stored in SQLite.
// Username/DisplayName are resolved via LEFT JOIN at query time — not stored.
type AppLog struct {
	ID          string      `json:"id"`
	Level       LogLevel    `json:"level"`
	Category    LogCategory `json:"category"`
	UserID      *string     `json:"user_id"`
	ServerID    *string     `json:"server_id"`
	Message     string      `json:"message"`
	Metadata    string      `json:"metadata"`
	CreatedAt   string      `json:"created_at"`
	Username    *string     `json:"username"`
	DisplayName *string     `json:"display_name"`
}

// AppLogFilter defines query parameters for listing logs.
type AppLogFilter struct {
	Level    string `json:"level"`
	Category string `json:"category"`
	Search   string `json:"search"`
	Limit    int    `json:"limit"`
	Offset   int    `json:"offset"`
}
