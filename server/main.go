// Package main, mqvi backend uygulamasının giriş noktasıdır.
//
// Bu dosyanın görevi — Dependency Injection "wire-up":
//   1.  Config'i yükle
//   2.  Database'i başlat
//   3.  i18n çevirilerini yükle
//   4.  Upload dizinini oluştur
//   5.  Repository'leri oluştur → init_repos.go
//   6.  Encryption key derive et (AES-256)
//   7.  Platform LiveKit instance seed et
//   8.  WebSocket Hub'ı başlat
//   9.  Hub callback'lerini kaydet → init_callbacks.go
//  10.  Service'leri oluştur → init_services.go
//  11.  Handler'ları oluştur → init_handlers.go
//  12.  Route'ları bağla → init_routes.go
//  13.  CORS yapılandır
//  14.  HTTP Server'ı başlat
//  15.  Graceful shutdown
//
// Global değişken YOK — her şey bu fonksiyonda oluşturulup birbirine bağlanıyor.
// Wire-up helper'ları init_*.go dosyalarındadır (aynı main package).
package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/pkg/i18n"
	"github.com/akinalp/mqvi/static"
	"github.com/akinalp/mqvi/ws"
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
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		log.Fatalf("[main] failed to access embedded migrations: %v", err)
	}

	db, err := database.New(cfg.Database.Path, migrationsFS)
	if err != nil {
		log.Fatalf("[main] failed to initialize database: %v", err)
	}
	defer db.Close()

	// ─── 3. i18n ───
	localesFS, err := fs.Sub(i18n.EmbeddedLocales, "locales")
	if err != nil {
		log.Fatalf("[main] failed to access embedded locales: %v", err)
	}
	if err := i18n.Load(localesFS); err != nil {
		log.Fatalf("[main] failed to load i18n translations: %v", err)
	}

	// ─── 4. Upload Dizini ───
	if err := os.MkdirAll(cfg.Upload.Dir, 0755); err != nil {
		log.Fatalf("[main] failed to create upload directory: %v", err)
	}

	// ─── 5. Repository Layer ───
	repos := initRepositories(db.Conn)

	// ─── 6. Encryption Key ───
	encryptionKey, err := crypto.DeriveKey(cfg.EncryptionKey)
	if err != nil {
		log.Fatalf("[main] invalid ENCRYPTION_KEY: %v", err)
	}

	// ─── 7. Empty-ID Cleanup + Presence Reset + LiveKit Seed ───
	runStartupCleanup(db, repos, cfg, encryptionKey)

	// ─── 8. WebSocket Hub ───
	hub := ws.NewHub()

	// ─── 9. Service Layer ───
	//
	// initServices sıralama-kritik service'leri doğru sırada oluşturur:
	// channelPermService → voiceService → p2pCallService → diğerleri
	svcs, limiters := initServices(db.Conn, repos, hub, cfg, encryptionKey)

	// ─── 10. Hub Callback'leri ───
	//
	// Callback'ler service'lerden SONRA kaydedilmeli (closure scoping).
	// Hub.Run() ise callback'lerden SONRA başlatılmalı.
	registerHubCallbacks(hub, repos.User, repos.DM, svcs.Voice, svcs.P2PCall, repos.Channel, repos.Server)

	go hub.Run()

	// ─── 11. Handler Layer ───
	h := initHandlers(svcs, repos, limiters, hub, cfg)

	// ─── 12. HTTP Router + Routes ───
	mux := http.NewServeMux()
	initRoutes(mux, h, svcs.Auth, repos.User, repos.Role, repos.Server)

	// ─── 13. Static file serving ───
	registerStaticAndUploads(mux, cfg)

	// ─── 14. SPA Frontend Serving ───
	frontendFS, hasFrontend := initFrontendFS()

	// ─── 15. CORS ───
	corsHandler := initCORS(cfg)

	// ─── 16. Final Handler ───
	apiHandler := corsHandler.Handler(mux)

	finalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" {
			apiHandler.ServeHTTP(w, r)
			return
		}

		if !hasFrontend {
			apiHandler.ServeHTTP(w, r)
			return
		}

		// Static dosya var mı?
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if f, openErr := frontendFS.Open(path); openErr == nil {
			f.Close()
			http.FileServer(http.FS(frontendFS)).ServeHTTP(w, r)
			return
		}

		// SPA fallback: bilinmeyen path → index.html
		indexData, readErr := fs.ReadFile(frontendFS, "index.html")
		if readErr != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexData)
	})

	// ─── 17. HTTP Server ───
	srv := &http.Server{
		Addr:         cfg.Server.Addr(),
		Handler:      finalHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// ─── 18. Graceful Shutdown ───
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

	hub.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("[main] forced shutdown: %v", err)
	}

	log.Println("[main] server stopped gracefully")
}

// ─── Startup Helper'ları ───
// Bunlar main.go'da kalıyor çünkü bir kere çalışıp biten startup mantığı.
// init_*.go dosyalarındaki helper'lar ise tekrar kullanılabilir wire-up fonksiyonları.

// runStartupCleanup, startup sırasındaki tek seferlik DB temizlik ve seed işlemleri.
func runStartupCleanup(db *database.DB, repos *Repositories, cfg *config.Config, encryptionKey []byte) {
	// ─── Empty-ID Cleanup ───
	{
		var emptyLK int
		if err := db.Conn.QueryRowContext(context.Background(),
			`SELECT COUNT(*) FROM livekit_instances WHERE id = ''`).Scan(&emptyLK); err != nil {
			log.Printf("[main] warning: failed to check empty-ID livekit instances: %v", err)
		}
		if emptyLK > 0 {
			var newLKID string
			if err := db.Conn.QueryRowContext(context.Background(),
				`SELECT lower(hex(randomblob(8)))`).Scan(&newLKID); err != nil {
				log.Printf("[main] warning: failed to generate new livekit ID: %v", err)
			} else {
				if _, err := db.Conn.ExecContext(context.Background(),
					`UPDATE livekit_instances SET id = ? WHERE id = ''`, newLKID); err != nil {
					log.Printf("[main] warning: failed to update empty-ID livekit instance: %v", err)
				}
				res, fixErr := db.Conn.ExecContext(context.Background(),
					`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ''`, newLKID)
				if fixErr != nil {
					log.Printf("[main] warning: failed to update server livekit refs: %v", fixErr)
				} else if aff, _ := res.RowsAffected(); aff > 0 {
					log.Printf("[main] fixed empty-ID livekit instance → %s (%d server refs updated)", newLKID, aff)
				}
			}
		}

		var emptySrv int
		if err := db.Conn.QueryRowContext(context.Background(),
			`SELECT COUNT(*) FROM servers WHERE id = ''`).Scan(&emptySrv); err != nil {
			log.Printf("[main] warning: failed to check empty-ID servers: %v", err)
		}
		if emptySrv > 0 {
			cleanupTables := []string{"channels", "categories", "roles", "user_roles", "invites", "bans", "server_members"}
			for _, table := range cleanupTables {
				if _, err := db.Conn.ExecContext(context.Background(),
					fmt.Sprintf(`DELETE FROM %s WHERE server_id = ''`, table)); err != nil {
					log.Printf("[main] warning: failed to clean empty-ID from %s: %v", table, err)
				}
			}
			if _, err := db.Conn.ExecContext(context.Background(), `DELETE FROM servers WHERE id = ''`); err != nil {
				log.Printf("[main] warning: failed to delete empty-ID servers: %v", err)
			}
			log.Printf("[main] cleaned up %d empty-ID server(s) and related data", emptySrv)
		}
	}

	// ─── Presence Reset ───
	{
		result, resetErr := db.Conn.ExecContext(context.Background(),
			`UPDATE users SET status = 'offline' WHERE status IN ('online', 'idle')`)
		if resetErr != nil {
			log.Printf("[main] warning: failed to reset stale presence: %v", resetErr)
		} else if affected, _ := result.RowsAffected(); affected > 0 {
			log.Printf("[main] reset %d stale user status(es) to offline", affected)
		}
	}

	// ─── Platform LiveKit Instance Seed ───
	if cfg.LiveKit.URL != "" && cfg.LiveKit.APIKey != "" && cfg.LiveKit.APISecret != "" {
		platformInstance, seedErr := repos.LiveKit.GetLeastLoadedPlatformInstance(context.Background())
		if seedErr != nil {
			encKey, encErr := crypto.Encrypt(cfg.LiveKit.APIKey, encryptionKey)
			if encErr != nil {
				log.Fatalf("[main] failed to encrypt platform livekit key: %v", encErr)
			}
			encSecret, encErr := crypto.Encrypt(cfg.LiveKit.APISecret, encryptionKey)
			if encErr != nil {
				log.Fatalf("[main] failed to encrypt platform livekit secret: %v", encErr)
			}

			platformInstance = &models.LiveKitInstance{
				URL:               cfg.LiveKit.URL,
				APIKey:            encKey,
				APISecret:         encSecret,
				IsPlatformManaged: true,
				ServerCount:       0,
			}
			if createErr := repos.LiveKit.Create(context.Background(), platformInstance); createErr != nil {
				log.Fatalf("[main] failed to seed platform livekit instance: %v", createErr)
			}
			log.Printf("[main] seeded platform LiveKit instance (url=%s, id=%s)", cfg.LiveKit.URL, platformInstance.ID)
		}

		result, linkErr := db.Conn.ExecContext(context.Background(),
			`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id IS NULL`,
			platformInstance.ID,
		)
		if linkErr != nil {
			log.Printf("[main] warning: failed to link orphan servers to platform livekit: %v", linkErr)
		} else if affected, _ := result.RowsAffected(); affected > 0 {
			log.Printf("[main] linked %d orphan server(s) to platform LiveKit instance", affected)
		}
	}
}

// registerStaticAndUploads, upload dosya serving endpoint'ini mux'a bağlar.
func registerStaticAndUploads(mux *http.ServeMux, cfg *config.Config) {
	uploadsHandler := http.StripPrefix("/api/uploads/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/") || strings.Contains(r.URL.Path, "\\") {
			http.NotFound(w, r)
			return
		}
		http.FileServer(http.Dir(cfg.Upload.Dir)).ServeHTTP(w, r)
	}))
	mux.Handle("GET /api/uploads/", uploadsHandler)

	// Health check
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","service":"mqvi"}`)
	})
}

// initFrontendFS, gömülü frontend dosyalarını yükler.
// hasFrontend: embedded frontend var mı (production build'de true, dev'de false).
func initFrontendFS() (fs.FS, bool) {
	frontendFS, err := fs.Sub(static.FrontendFS, "dist")
	if err != nil {
		log.Fatalf("[main] failed to access embedded frontend: %v", err)
	}

	hasFrontend := false
	if f, checkErr := frontendFS.(fs.ReadFileFS).ReadFile("index.html"); checkErr == nil && len(f) > 0 {
		hasFrontend = true
		log.Println("[main] embedded frontend detected, SPA serving enabled")
	} else {
		log.Println("[main] no embedded frontend, API-only mode (use Vite dev server for frontend)")
	}

	return frontendFS, hasFrontend
}

// initCORS, CORS handler'ını yapılandırır.
func initCORS(cfg *config.Config) *cors.Cors {
	corsOrigins := []string{
		"http://localhost:3030",
		"http://localhost:1420",
		"tauri://localhost",
		"https://tauri.localhost",
		"http://tauri.localhost",
	}
	if extra := os.Getenv("CORS_ORIGINS"); extra != "" {
		for _, origin := range strings.Split(extra, ",") {
			origin = strings.TrimSpace(origin)
			if origin != "" {
				corsOrigins = append(corsOrigins, origin)
			}
		}
	}
	log.Printf("[cors] allowed origins: %v", corsOrigins)
	return cors.New(cors.Options{
		AllowedOrigins:   corsOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	})
}
