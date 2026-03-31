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
	LogCategoryWS          LogCategory = "ws"
	LogCategoryAuth        LogCategory = "auth"
	LogCategoryGeneral     LogCategory = "general"
	LogCategoryFeedback    LogCategory = "feedback"
)

// AppLog represents a structured log entry stored in SQLite.
type AppLog struct {
	ID        string      `json:"id"`
	Level     LogLevel    `json:"level"`
	Category  LogCategory `json:"category"`
	UserID    *string     `json:"user_id"`
	ServerID  *string     `json:"server_id"`
	Message   string      `json:"message"`
	Metadata  string      `json:"metadata"`
	CreatedAt string      `json:"created_at"`
}

// AppLogFilter defines query parameters for listing logs.
type AppLogFilter struct {
	Level    string `json:"level"`
	Category string `json:"category"`
	Search   string `json:"search"`
	Limit    int    `json:"limit"`
	Offset   int    `json:"offset"`
}
