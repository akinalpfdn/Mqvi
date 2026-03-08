package models

import "github.com/golang-jwt/jwt/v5"

// TokenClaims — JWT payload. Defined in models to avoid circular deps
// between services, ws, and middleware.
type TokenClaims struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}
