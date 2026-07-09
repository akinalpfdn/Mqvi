package models

// ServerJoinRequest is a pending request to join an approval-required server.
// Pending requesters are NOT members (not in server_members) until approved.
type ServerJoinRequest struct {
	ServerID   string  `json:"server_id"`
	UserID     string  `json:"user_id"`
	InviteCode *string `json:"invite_code,omitempty"`
	CreatedAt  string  `json:"created_at"`
}

// ServerJoinRequestWithUser enriches a pending request with the requester's public
// profile for the approval list.
type ServerJoinRequestWithUser struct {
	ServerJoinRequest
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name,omitempty"`
	AvatarURL   *string `json:"avatar_url,omitempty"`
}
