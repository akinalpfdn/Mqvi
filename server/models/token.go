package models

import "github.com/golang-jwt/jwt/v5"

// TokenClaims, JWT token'ın içindeki veriler (payload).
//
// JWT (JSON Web Token) nedir?
// Kullanıcı kimliğini doğrulamak için kullanılan, imzalanmış bir token.
// 3 parçadan oluşur: header.payload.signature
//
// Payload'da kullanıcı ID'si ve token'ın expire süresi bulunur.
// Server her request'te bu token'ı doğrular — DB'ye gitmeden
// kullanıcının kim olduğunu bilir.
//
// Bu struct models paketinde tanımlanır çünkü:
// - Birden fazla katman (services, ws, middleware) tarafından kullanılır
// - Circular dependency'yi önler — her katman models'e bağımlı olabilir
type TokenClaims struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}
