package config

import (
	"fmt"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

type Config struct {
	Server          ServerConfig
	Database        DatabaseConfig
	JWT             JWTConfig
	LiveKit         LiveKitConfig
	Upload          UploadConfig
	Email           EmailConfig
	Klipy           KlipyConfig
	EncryptionKey   string // AES-256 key (64 hex chars = 32 bytes) for LiveKit credential encryption
	HetznerAPIToken string // Hetzner Cloud API token (read-only) — optional
}

// EmailConfig — optional. If RESEND_API_KEY is empty, password reset is disabled.
type EmailConfig struct {
	ResendAPIKey string
	FromEmail    string // e.g. noreply@mqvi.app
	AppURL       string // e.g. https://app.mqvi.app — used in reset links
}

// KlipyConfig — optional. If KLIPY_API_KEY is empty, GIF search is disabled.
type KlipyConfig struct {
	APIKey string
}

type ServerConfig struct {
	Host string
	Port int
}

type DatabaseConfig struct {
	Path string
}

type JWTConfig struct {
	Secret             string
	AccessTokenExpiry  int // minutes (default: 15)
	RefreshTokenExpiry int // days (default: 7)
}

type LiveKitConfig struct {
	URL       string
	APIKey    string
	APISecret string
}

type UploadConfig struct {
	Dir     string
	MaxSize int64 // bytes (default: 25MB)
	// PublicURL is the absolute base URL prepended to file URLs when they need
	// to be served cross-origin or via CDN, e.g. "https://files.mqvi.net".
	// Empty means file URLs are returned as relative paths (current behaviour).
	// Wired in PHASE-10; first consumer is the signed-URL generator (PHASE-11).
	PublicURL string
}

// Load reads configuration from environment variables.
// Falls back to .env file in development.
func Load() (*Config, error) {
	_ = godotenv.Load()

	port, err := strconv.Atoi(getEnv("SERVER_PORT", "9090"))
	if err != nil {
		return nil, fmt.Errorf("invalid SERVER_PORT: %w", err)
	}

	accessExpiry, err := strconv.Atoi(getEnv("JWT_ACCESS_EXPIRY_MINUTES", "15"))
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_ACCESS_EXPIRY_MINUTES: %w", err)
	}

	refreshExpiry, err := strconv.Atoi(getEnv("JWT_REFRESH_EXPIRY_DAYS", "7"))
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_REFRESH_EXPIRY_DAYS: %w", err)
	}

	maxSize, err := strconv.ParseInt(getEnv("UPLOAD_MAX_SIZE", "26214400"), 10, 64) // 25MB
	if err != nil {
		return nil, fmt.Errorf("invalid UPLOAD_MAX_SIZE: %w", err)
	}

	jwtSecret := getEnv("JWT_SECRET", "")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET environment variable is required")
	}

	encKey := getEnv("ENCRYPTION_KEY", "")
	if encKey == "" {
		return nil, fmt.Errorf("ENCRYPTION_KEY environment variable is required (64 hex chars = 32 byte AES-256 key)")
	}

	cfg := &Config{
		Server: ServerConfig{
			Host: getEnv("SERVER_HOST", "0.0.0.0"),
			Port: port,
		},
		Database: DatabaseConfig{
			Path: getEnv("DATABASE_PATH", "./data/mqvi.db"),
		},
		JWT: JWTConfig{
			Secret:             jwtSecret,
			AccessTokenExpiry:  accessExpiry,
			RefreshTokenExpiry: refreshExpiry,
		},
		LiveKit: LiveKitConfig{
			URL:       getEnv("LIVEKIT_URL", "ws://localhost:7880"),
			APIKey:    getEnv("LIVEKIT_API_KEY", ""),
			APISecret: getEnv("LIVEKIT_API_SECRET", ""),
		},
		Upload: UploadConfig{
			Dir:       getEnv("UPLOAD_DIR", "./data/uploads"),
			MaxSize:   maxSize,
			PublicURL: getEnv("MQVI_PUBLIC_FILE_URL", ""),
		},
		Email: EmailConfig{
			ResendAPIKey: getEnv("RESEND_API_KEY", ""),
			FromEmail:    getEnv("RESEND_FROM", ""),
			AppURL:       getEnv("APP_URL", ""),
		},
		Klipy: KlipyConfig{
			APIKey: getEnv("KLIPY_API_KEY", ""),
		},
		EncryptionKey:   encKey,
		HetznerAPIToken: getEnv("HETZNER_API_TOKEN", ""),
	}

	return cfg, nil
}

// Addr returns the listen address (e.g. "0.0.0.0:8080").
func (c *ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}
