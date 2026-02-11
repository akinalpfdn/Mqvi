// Package main, mqvi backend uygulamasının giriş noktasıdır.
//
// Bu dosyanın görevi — Dependency Injection "wire-up":
//   1.  Config'i yükle
//   2.  Database'i başlat
//   3.  i18n çevirilerini yükle
//   4.  Upload dizinini oluştur
//   5.  Repository'leri oluştur (DB bağlantısı ile)
//   6.  Service'leri oluştur (repository'ler ile)
//   7.  Handler'ları oluştur (service'ler ile)
//   8.  Middleware'ları oluştur (service + repo'lar ile)
//   9.  HTTP router'ı kur, route'ları bağla
//  10.  CORS yapılandır
//  11.  HTTP Server'ı başlat
//  12.  Graceful shutdown
//
// Global değişken YOK — her şey bu fonksiyonda oluşturulup birbirine bağlanıyor.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/middleware"
	"github.com/akinalp/mqvi/pkg/i18n"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
	"github.com/rs/cors"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Println("[main] mqvi server starting...")

	// ─── 1. Config ───
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[main] failed to load config: %v", err)
	}
	log.Printf("[main] config loaded (port=%d)", cfg.Server.Port)

	// ─── 2. Database ───
	_, filename, _, _ := runtime.Caller(0)
	baseDir := filepath.Dir(filename)
	migrationsDir := filepath.Join(baseDir, "database", "migrations")

	db, err := database.New(cfg.Database.Path, migrationsDir)
	if err != nil {
		log.Fatalf("[main] failed to initialize database: %v", err)
	}
	defer db.Close()

	// ─── 3. i18n (Çoklu Dil Desteği) ───
	// Backend tarafında API error mesajları kullanıcının diline göre döner.
	// Çeviri dosyaları server/pkg/i18n/locales/ altında: en.json, tr.json
	// i18n.Load sadece bir kere çalışır (sync.Once ile korunur).
	localesDir := filepath.Join(baseDir, "pkg", "i18n", "locales")
	if err := i18n.Load(localesDir); err != nil {
		log.Fatalf("[main] failed to load i18n translations: %v", err)
	}

	// ─── 4. Upload Dizini ───
	if err := os.MkdirAll(cfg.Upload.Dir, 0755); err != nil {
		log.Fatalf("[main] failed to create upload directory: %v", err)
	}

	// ─── 5. Repository Layer ───
	// Her repository, *sql.DB alır ve interface döner.
	// Concrete struct değil interface döndüğüne dikkat — Dependency Inversion.
	userRepo := repository.NewSQLiteUserRepo(db.Conn)
	sessionRepo := repository.NewSQLiteSessionRepo(db.Conn)
	roleRepo := repository.NewSQLiteRoleRepo(db.Conn)

	// ─── 6. Service Layer ───
	// Service'ler repository interface'lerini alır.
	// Böylece test'te mock repository verebiliriz.
	authService := services.NewAuthService(
		userRepo,
		sessionRepo,
		roleRepo,
		cfg.JWT.Secret,
		cfg.JWT.AccessTokenExpiry,
		cfg.JWT.RefreshTokenExpiry,
	)

	// ─── 7. Handler Layer ───
	authHandler := handlers.NewAuthHandler(authService)

	// ─── 8. Middleware ───
	authMiddleware := middleware.NewAuthMiddleware(authService, userRepo)

	// ─── 9. HTTP Router ───
	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","service":"mqvi"}`)
	})

	// Auth — public endpoint'ler (token gerekmez)
	mux.HandleFunc("POST /api/auth/register", authHandler.Register)
	mux.HandleFunc("POST /api/auth/login", authHandler.Login)
	mux.HandleFunc("POST /api/auth/refresh", authHandler.Refresh)
	mux.HandleFunc("POST /api/auth/logout", authHandler.Logout)

	// Protected endpoint'ler — authMiddleware.Require() sarar
	mux.Handle("GET /api/users/me", authMiddleware.Require(http.HandlerFunc(authHandler.Me)))

	// ─── 10. CORS ───
	corsHandler := cors.New(cors.Options{
		AllowedOrigins: []string{
			"http://localhost:3000",  // Vite dev server
			"http://localhost:1420",  // Tauri dev
			"tauri://localhost",      // Tauri production
		},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
		Debug:            false, // true yaparsan CORS debug logları görürsün
	})

	handler := corsHandler.Handler(mux)

	// ─── 11. HTTP Server ───
	srv := &http.Server{
		Addr:         cfg.Server.Addr(),
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// ─── 12. Graceful Shutdown ───
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("[main] server listening on %s", cfg.Server.Addr())
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[main] server error: %v", err)
		}
	}()

	<-done
	log.Println("[main] shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("[main] forced shutdown: %v", err)
	}

	log.Println("[main] server stopped gracefully")
}
