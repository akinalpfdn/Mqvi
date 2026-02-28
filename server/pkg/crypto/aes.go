// Package crypto — AES-256-GCM şifreleme/çözümleme fonksiyonları.
//
// LiveKit credential'ları gibi hassas verileri veritabanında şifrelenmiş
// saklamak için kullanılır.
//
// AES-256-GCM nedir?
// - AES-256: 256-bit anahtar ile şifreleme (symmetric encryption)
// - GCM (Galois/Counter Mode): hem gizlilik hem bütünlük sağlar (authenticated encryption)
// - Nonce: her şifreleme için rastgele üretilen 12-byte değer — aynı key ile bile
//   her ciphertext farklı olur (replay attack koruması)
//
// Kullanım:
//   key, _ := crypto.DeriveKey("hex-encoded-32-byte-key")
//   encrypted, _ := crypto.Encrypt("secret", key)
//   decrypted, _ := crypto.Decrypt(encrypted, key)
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
)

// DeriveKey, hex-encoded string'den 32-byte AES-256 anahtarı oluşturur.
// Input tam 64 hex karakter (= 32 byte) olmalıdır.
func DeriveKey(hexKey string) ([]byte, error) {
	key, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, fmt.Errorf("invalid hex key: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("key must be exactly 32 bytes (64 hex chars), got %d bytes", len(key))
	}
	return key, nil
}

// Encrypt, plaintext'i AES-256-GCM ile şifreler.
// Dönen string base64-encoded: nonce (12 byte) + ciphertext.
func Encrypt(plaintext string, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("aes.NewCipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("cipher.NewGCM: %w", err)
	}

	// Nonce: her şifreleme için rastgele 12-byte değer.
	// GCM standard nonce size = 12 byte.
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("nonce generation: %w", err)
	}

	// Seal: nonce + ciphertext + authentication tag birleştirilir.
	// İlk parametre (dst): nonce'u prefix olarak ekle.
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)

	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// Decrypt, AES-256-GCM ile şifrelenmiş base64 string'i çözer.
func Decrypt(encoded string, key []byte) (string, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("aes.NewCipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("cipher.NewGCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	// İlk 12 byte = nonce, gerisi = ciphertext + auth tag
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]

	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("gcm.Open (decryption failed — wrong key or corrupted data): %w", err)
	}

	return string(plaintext), nil
}
