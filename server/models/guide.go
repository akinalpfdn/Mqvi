package models

// GuideSteps says which onboarding steps the user has done, derived from their own data.
type GuideSteps struct {
	// Community: member of at least one server (joined or created).
	Community bool `json:"community"`
	// Message: has sent at least one channel message.
	Message bool `json:"message"`
	// Voice: has joined a voice channel.
	Voice bool `json:"voice"`
	// Friend: has a friend or has sent a friend request.
	Friend bool `json:"friend"`
	// Profile: has set an avatar.
	Profile bool `json:"profile"`
	// Roles: has created a role in a server they own (beyond the built-in everyone and owner).
	Roles bool `json:"roles"`
	// App: has used the desktop or mobile app.
	App bool `json:"app"`
}

// GuideState is the onboarding guide as the client draws it.
type GuideState struct {
	Steps  GuideSteps `json:"steps"`
	Hidden bool       `json:"hidden"`
}

// UpdateGuideRequest is the body of PUT /api/users/me/guide.
type UpdateGuideRequest struct {
	Hidden bool `json:"hidden"`
}
