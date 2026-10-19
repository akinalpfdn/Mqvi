package models

import "github.com/golang-jwt/jwt/v5"

// Audience values for JWT aud claim. Tokens issued for one audience MUST be
// rejected at endpoints expecting a different one.
const (
	AudienceAPI  = "api"  // /api/* endpoints (except /api/files)
	AudienceFile = "file" // /api/files only — separate long-lived token
)

// TokenClaims — JWT payload.
type TokenClaims struct {
	UserID       string `json:"user_id"`
	Username     string `json:"username"`
	TokenVersion int    `json:"tv,omitempty"`  // bumped on password change to invalidate prior tokens
	SessionID    string `json:"sid,omitempty"` // the device session that issued it
	jwt.RegisteredClaims
}
