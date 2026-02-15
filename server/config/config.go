// Package config, uygulamanın tüm konfigürasyonunu merkezi olarak yönetir.
// Environment variable'lardan okur, .env dosyasını da destekler.
//
// Go'da "struct" bir veri yapısıdır — birden fazla field'ı bir arada tutar.
// Config struct'ı tüm ayarları tek bir yerde toplar, böylece
// her yerde ayrı ayrı os.Getenv() çağırmak yerine tek bir Config nesnesi taşırız.
package config

import (
	"fmt"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

// Config, uygulamanın tüm konfigürasyon değerlerini taşır.
// Her alt bölüm ayrı bir struct — Single Responsibility: her struct tek bir concern'ü temsil eder.
type Config struct {
	Server   ServerConfig
	Database DatabaseConfig
	JWT      JWTConfig
	LiveKit  LiveKitConfig
	Upload   UploadConfig
}

// ServerConfig, HTTP server ayarları.
type ServerConfig struct {
	Host string
	Port int
}

// DatabaseConfig, SQLite database ayarları.
type DatabaseConfig struct {
	Path string // SQLite dosya yolu (ör: ./data/mqvi.db)
}

// JWTConfig, JWT token ayarları.
type JWTConfig struct {
	Secret             string // Token imzalama anahtarı — GİZLİ TUTULMALI
	AccessTokenExpiry  int    // Dakika cinsinden (varsayılan: 15)
	RefreshTokenExpiry int    // Gün cinsinden (varsayılan: 7)
}

// LiveKitConfig, LiveKit SFU server ayarları.
type LiveKitConfig struct {
	URL       string // LiveKit server URL (ör: ws://localhost:7880)
	APIKey    string
	APISecret string
}

// UploadConfig, dosya yükleme ayarları.
type UploadConfig struct {
	Dir     string // Dosyaların kaydedileceği dizin
	MaxSize int64  // Byte cinsinden max dosya boyutu (varsayılan: 25MB)
}

// Load, environment variable'lardan Config oluşturur.
// .env dosyası varsa önce onu yükler (development kolaylığı için).
//
// Go'da error handling: Go'da exception/try-catch yoktur.
// Fonksiyonlar hata durumunda (value, error) tuple'ı döner.
// Çağıran taraf her zaman error'ı kontrol ETMEK ZORUNDADIR.
func Load() (*Config, error) {
	// .env dosyasını yükle — dosya yoksa hata vermez, sessizce devam eder.
	// Production'da bu dosya olmaz, gerçek env variable'lar kullanılır.
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
			Dir:     getEnv("UPLOAD_DIR", "./data/uploads"),
			MaxSize: maxSize,
		},
	}

	return cfg, nil
}

// Addr, HTTP server'ın dinleyeceği adresi döner (ör: "0.0.0.0:8080").
func (c *ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

// getEnv, environment variable'ı okur, yoksa fallback değeri döner.
func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}
