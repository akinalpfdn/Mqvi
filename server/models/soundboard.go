package models

import "time"

type SoundboardSound struct {
	ID         string    `json:"id"`
	ServerID   string    `json:"server_id"`
	Name       string    `json:"name"`
	Emoji      *string   `json:"emoji"`
	FileURL    string    `json:"file_url"`
	FileSize   int64     `json:"file_size"`
	DurationMs int       `json:"duration_ms"`
	UploadedBy string    `json:"uploaded_by"`
	CreatedAt  time.Time `json:"created_at"`

	// Joined fields
	UploaderUsername    string `json:"uploader_username,omitempty"`
	UploaderDisplayName string `json:"uploader_display_name,omitempty"`
}

type CreateSoundboardSoundRequest struct {
	Name  string  `json:"name"`
	Emoji *string `json:"emoji"`
}

type UpdateSoundboardSoundRequest struct {
	Name  *string `json:"name,omitempty"`
	Emoji *string `json:"emoji,omitempty"`
}

type SoundboardPlayEvent struct {
	SoundID    string `json:"sound_id"`
	SoundName  string `json:"sound_name"`
	SoundURL   string `json:"sound_url"`
	UserID     string `json:"user_id"`
	Username   string `json:"username"`
	ServerID   string `json:"server_id"`
	ChannelID  string `json:"channel_id"`
}
