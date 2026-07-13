package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	Server          ServerConfig
	Database        DatabaseConfig
	JWT             JWTConfig
	LiveKit         LiveKitConfig
	Upload          UploadConfig
	Antivirus       AntivirusConfig
	FileRateLimit   FileRateLimitConfig
	Email           EmailConfig
	Klipy           KlipyConfig
	TURN            TURNConfig
	Push            PushConfig
	EncryptionKey   string // AES-256 key (64 hex chars = 32 bytes) for LiveKit credential encryption
	HetznerAPIToken string // Hetzner Cloud API token (read-only) — optional
	// PasswordBreachCheck queries Have I Been Pwned when a password is set. Needs no key or
	// account; turn it off only for a self-host with no route out. Failures allow the password.
	PasswordBreachCheck bool
}

// PushConfig — optional. If CredentialsFile is missing or invalid, push is disabled
// and the server still starts (same pattern as Email/Klipy).
type PushConfig struct {
	// CredentialsFile is the path to the Firebase service-account JSON used by the
	// Admin SDK to send FCM messages.
	CredentialsFile string
	// APNs — optional iOS VoIP (PushKit/CallKit) push via direct APNs.
	APNs APNsConfig
}

// APNsConfig holds token-based (.p8) APNs auth for iOS VoIP pushes. Disabled if any
// of KeyPath/KeyID/TeamID is unset. The same .p8 uploaded to Firebase for FCM works.
type APNsConfig struct {
	KeyPath    string // path to the AuthKey_XXXX.p8
	KeyID      string
	TeamID     string
	BundleID   string // voip topic = BundleID + ".voip"
	Production bool   // false => APNs sandbox (Xcode dev builds); true => production
}

// TURNConfig holds the STUN/TURN servers handed to P2P call clients.
// P2P 1-on-1 calls are central and friendship-scoped, so a single TURN
// surface serves every call.
type TURNConfig struct {
	// Secret is the shared HMAC secret matching coturn's use-auth-secret.
	// Empty => TURN disabled, clients get STUN-only (P2P still works on
	// non-restrictive networks, just no relay fallback).
	Secret string
	// URLs are the TURN server URLs given to clients,
	// e.g. "turn:turn.mqvi.app:3478?transport=udp".
	URLs []string
	// STUNURLs are STUN-only servers (no credentials).
	STUNURLs []string
	// CredentialTTLSeconds is how long a minted TURN credential stays valid.
	CredentialTTLSeconds int
}

// defaultSTUNURLs — public Google STUN, used when STUN_URLS is unset.
const defaultSTUNURLs = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"

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
	Dir               string
	MaxSize           int64 // bytes (default: 500MB)
	DefaultQuotaBytes int64 // per-user storage quota (default: 10GB)
	// PublicURL is the absolute base URL prepended to file URLs when they need
	// to be served cross-origin or via CDN, e.g. "https://files.mqvi.net".
	// Empty means file URLs are returned as relative paths (current behaviour).
	PublicURL string
	// SignedURLSecret is the HMAC-SHA256 key for signing file URLs (32 bytes, base64-encoded).
	// Required in production. If empty, server refuses to start.
	SignedURLSecret string
	// SignedURLSecretPrev is the previous signing key, still accepted for verification
	// during key rotation. URLs are only signed with the active key.
	SignedURLSecretPrev string
}

type AntivirusConfig struct {
	Enabled                 bool
	ClamAVAddr              string
	TimeoutSeconds          int
	MaxScanSizeBytes        int64
	UnavailablePolicy       string
	TooLargePolicy          string
	CleanCacheTTLHours      int
	InfectedCacheTTLDays    int
	CircuitFailureThreshold int
	CircuitWindowSeconds    int
	CircuitOpenSeconds      int
}

type FileRateLimitConfig struct {
	UserPerMin int
	IPPerMin   int
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

	maxSize, err := strconv.ParseInt(getEnv("UPLOAD_MAX_SIZE", "104857600"), 10, 64) // 100 MB — Cloudflare body limit
	if err != nil {
		return nil, fmt.Errorf("invalid UPLOAD_MAX_SIZE: %w", err)
	}

	defaultQuota, err := strconv.ParseInt(getEnv("MQVI_DEFAULT_QUOTA_BYTES", "10737418240"), 10, 64) // 10GB
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_DEFAULT_QUOTA_BYTES: %w", err)
	}

	fileRateUser, err := strconv.Atoi(getEnv("MQVI_FILE_RATE_USER_PER_MIN", "600"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_FILE_RATE_USER_PER_MIN: %w", err)
	}

	fileRateIP, err := strconv.Atoi(getEnv("MQVI_FILE_RATE_IP_PER_MIN", "2000"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_FILE_RATE_IP_PER_MIN: %w", err)
	}

	avEnabled, err := strconv.ParseBool(getEnv("MQVI_ANTIVIRUS_ENABLED", "true"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_ENABLED: %w", err)
	}

	breachCheck, err := strconv.ParseBool(getEnv("MQVI_PASSWORD_BREACH_CHECK", "true"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_PASSWORD_BREACH_CHECK: %w", err)
	}
	avTimeout, err := strconv.Atoi(getEnv("MQVI_ANTIVIRUS_TIMEOUT_SECONDS", "10"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_TIMEOUT_SECONDS: %w", err)
	}
	avMaxScanMB, err := strconv.ParseInt(getEnv("MQVI_ANTIVIRUS_MAX_SCAN_SIZE_MB", "25"), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_MAX_SCAN_SIZE_MB: %w", err)
	}
	avCleanTTL, err := strconv.Atoi(getEnv("MQVI_ANTIVIRUS_CLEAN_CACHE_TTL_HOURS", "24"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_CLEAN_CACHE_TTL_HOURS: %w", err)
	}
	avInfectedTTL, err := strconv.Atoi(getEnv("MQVI_ANTIVIRUS_INFECTED_CACHE_TTL_DAYS", "30"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_INFECTED_CACHE_TTL_DAYS: %w", err)
	}
	avCircuitFailures, err := strconv.Atoi(getEnv("MQVI_ANTIVIRUS_CIRCUIT_FAILURE_THRESHOLD", "3"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_CIRCUIT_FAILURE_THRESHOLD: %w", err)
	}
	avCircuitWindow, err := strconv.Atoi(getEnv("MQVI_ANTIVIRUS_CIRCUIT_WINDOW_SECONDS", "30"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_CIRCUIT_WINDOW_SECONDS: %w", err)
	}
	avCircuitOpen, err := strconv.Atoi(getEnv("MQVI_ANTIVIRUS_CIRCUIT_OPEN_SECONDS", "10"))
	if err != nil {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_CIRCUIT_OPEN_SECONDS: %w", err)
	}
	avUnavailablePolicy := strings.ToLower(strings.TrimSpace(getEnv("MQVI_ANTIVIRUS_UNAVAILABLE_POLICY", "allow_with_log")))
	if avUnavailablePolicy != "allow_with_log" && avUnavailablePolicy != "reject" {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_UNAVAILABLE_POLICY: %s", avUnavailablePolicy)
	}
	avTooLargePolicy := strings.ToLower(strings.TrimSpace(getEnv("MQVI_ANTIVIRUS_TOO_LARGE_POLICY", "skip_with_log")))
	if avTooLargePolicy != "skip_with_log" && avTooLargePolicy != "reject" {
		return nil, fmt.Errorf("invalid MQVI_ANTIVIRUS_TOO_LARGE_POLICY: %s", avTooLargePolicy)
	}
	if avTimeout <= 0 {
		return nil, fmt.Errorf("MQVI_ANTIVIRUS_TIMEOUT_SECONDS must be positive")
	}
	if avMaxScanMB < 0 || avCleanTTL < 0 || avInfectedTTL < 0 || avCircuitFailures < 0 || avCircuitWindow < 0 || avCircuitOpen < 0 {
		return nil, fmt.Errorf("antivirus TTL and circuit values must not be negative")
	}

	jwtSecret := getEnv("JWT_SECRET", "")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET environment variable is required")
	}

	encKey := getEnv("ENCRYPTION_KEY", "")
	if encKey == "" {
		return nil, fmt.Errorf("ENCRYPTION_KEY environment variable is required (64 hex chars = 32 byte AES-256 key)")
	}

	// Default 24h: a TURN credential must outlast any single call, otherwise a
	// relayed call drops when coturn rejects the next allocation refresh.
	turnTTL, err := strconv.Atoi(getEnv("TURN_CREDENTIAL_TTL_SECONDS", "86400"))
	if err != nil {
		return nil, fmt.Errorf("invalid TURN_CREDENTIAL_TTL_SECONDS: %w", err)
	}
	// Fail fast on an invalid TTL — single source of truth, no silent fallback.
	// Upper bound (7 days) also prevents int64 nanosecond overflow downstream.
	if turnTTL <= 0 || turnTTL > 604800 {
		return nil, fmt.Errorf("TURN_CREDENTIAL_TTL_SECONDS must be between 1 and 604800 (7 days), got %d", turnTTL)
	}

	turnSecret := strings.TrimSpace(getEnv("TURN_SECRET", ""))
	turnURLs := splitCSV(getEnv("TURN_URLS", ""))
	stunURLs := splitCSV(getEnv("STUN_URLS", defaultSTUNURLs))
	if err := validateICEServers(turnSecret, turnURLs, stunURLs); err != nil {
		return nil, err
	}

	// Optional iOS VoIP push flag — invalid value defaults to sandbox (push is optional).
	apnsProduction, _ := strconv.ParseBool(getEnv("APNS_PRODUCTION", "false"))

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
			Dir:                 getEnv("UPLOAD_DIR", "./data/uploads"),
			MaxSize:             maxSize,
			DefaultQuotaBytes:   defaultQuota,
			PublicURL:           getEnv("MQVI_PUBLIC_FILE_URL", ""),
			SignedURLSecret:     getEnv("MQVI_SIGNED_URL_SECRET", ""),
			SignedURLSecretPrev: getEnv("MQVI_SIGNED_URL_SECRET_PREV", ""),
		},
		Antivirus: AntivirusConfig{
			Enabled:                 avEnabled,
			ClamAVAddr:              getEnv("MQVI_CLAMAV_ADDR", "unix:/run/clamav/clamd.ctl"),
			TimeoutSeconds:          avTimeout,
			MaxScanSizeBytes:        avMaxScanMB * 1024 * 1024,
			UnavailablePolicy:       avUnavailablePolicy,
			TooLargePolicy:          avTooLargePolicy,
			CleanCacheTTLHours:      avCleanTTL,
			InfectedCacheTTLDays:    avInfectedTTL,
			CircuitFailureThreshold: avCircuitFailures,
			CircuitWindowSeconds:    avCircuitWindow,
			CircuitOpenSeconds:      avCircuitOpen,
		},
		FileRateLimit: FileRateLimitConfig{
			UserPerMin: fileRateUser,
			IPPerMin:   fileRateIP,
		},
		Email: EmailConfig{
			ResendAPIKey: getEnv("RESEND_API_KEY", ""),
			FromEmail:    getEnv("RESEND_FROM", ""),
			AppURL:       getEnv("APP_URL", ""),
		},
		Klipy: KlipyConfig{
			APIKey: getEnv("KLIPY_API_KEY", ""),
		},
		TURN: TURNConfig{
			Secret:               turnSecret,
			URLs:                 turnURLs,
			STUNURLs:             stunURLs,
			CredentialTTLSeconds: turnTTL,
		},
		Push: PushConfig{
			CredentialsFile: getEnv("FCM_CREDENTIALS_FILE", "./firebase-service-account.json"),
			APNs: APNsConfig{
				KeyPath:    getEnv("APNS_KEY_FILE", "./apns-key.p8"),
				KeyID:      getEnv("APNS_KEY_ID", ""),
				TeamID:     getEnv("APNS_TEAM_ID", ""),
				BundleID:   getEnv("APNS_BUNDLE_ID", "net.mqvi.app"),
				Production: apnsProduction,
			},
		},
		EncryptionKey:       encKey,
		HetznerAPIToken:     getEnv("HETZNER_API_TOKEN", ""),
		PasswordBreachCheck: breachCheck,
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

// validateICEServers fails fast on misconfigured STUN/TURN values so a bad
// config surfaces at startup, not on the first restrictive-NAT call (where it
// would silently degrade to STUN-only and break the relay).
func validateICEServers(turnSecret string, turnURLs, stunURLs []string) error {
	for _, u := range stunURLs {
		if !strings.HasPrefix(u, "stun:") && !strings.HasPrefix(u, "stuns:") {
			return fmt.Errorf("invalid STUN URL %q: must start with stun: or stuns:", u)
		}
	}
	// TURN is "enabled" only when URLs are present; then it needs a strong shared
	// secret and valid turn:/turns: schemes (the dangerous misconfig: relay
	// advertised but broken). A leftover secret without URLs is harmless — it just
	// means no relay (STUN-only), so it's ignored rather than failed (avoids a
	// deploy footgun where the setup script writes the secret before the URLs).
	if len(turnURLs) > 0 {
		if len(turnSecret) < 16 {
			return fmt.Errorf("TURN_SECRET must be at least 16 chars when TURN_URLS is set")
		}
		for _, u := range turnURLs {
			if !strings.HasPrefix(u, "turn:") && !strings.HasPrefix(u, "turns:") {
				return fmt.Errorf("invalid TURN URL %q: must start with turn: or turns:", u)
			}
		}
	}
	return nil
}

// splitCSV splits a comma-separated env value, trimming whitespace and
// dropping empty entries.
func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
