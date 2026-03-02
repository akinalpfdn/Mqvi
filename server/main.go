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
	"html"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/pkg/i18n"
	"github.com/akinalp/mqvi/services"
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
	svcs, limiters, metricsCollector := initServices(db.Conn, repos, hub, cfg, encryptionKey)

	// ─── 10. Hub Callback'leri ───
	//
	// Callback'ler service'lerden SONRA kaydedilmeli (closure scoping).
	// Hub.Run() ise callback'lerden SONRA başlatılmalı.
	registerHubCallbacks(hub, repos.User, repos.DM, svcs.Voice, svcs.P2PCall, repos.Channel, repos.Server)

	go hub.Run()

	// ─── 10b. Metrics Collector ───
	//
	// Arka plan goroutine'i: her 5 dakikada tüm platform-managed LiveKit
	// instance'lardan Prometheus metrikleri çeker ve DB'ye yazar.
	// Graceful shutdown'da Stop() çağrılır.
	metricsCollector.Start()

	// ─── 11. Handler Layer ───
	h := initHandlers(svcs, repos, limiters, hub, cfg)

	// ─── 12. HTTP Router + Routes ───
	mux := http.NewServeMux()
	initRoutes(mux, h, svcs.Auth, repos.User, repos.Role, repos.Server)

	// ─── 13. Static file serving ───
	registerStaticAndUploads(mux, cfg)

	// ─── 14. SPA Frontend Serving ───
	frontendFS, hasFrontend := initFrontendFS()

	// Web serving için index.html — relative path'leri absolute'a çevir.
	//
	// Vite build'de base "./" kullanılır (Electron file:// uyumluluğu için).
	// Ancak web'de /invite/abc gibi nested route'larda browser "./assets/index.js"'i
	// "/invite/assets/index.js" olarak çözer → dosya bulunamaz → SPA fallback index.html döner
	// → MIME type text/html hatası.
	//
	// Çözüm: Startup'ta bir kez "./" → "/" dönüşümü yapıp cache'le.
	// Electron etkilenmez — dosyayı doğrudan diskten okur, Go backend kullanmaz.
	var indexHTMLWeb []byte
	if hasFrontend {
		raw, readErr := fs.ReadFile(frontendFS, "index.html")
		if readErr == nil {
			indexHTMLWeb = []byte(strings.ReplaceAll(string(raw), `"./`, `"/`))
		}
	}

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

		// OG meta tag — sosyal medya crawler'ları (WhatsApp, Telegram, Twitter, Facebook vb.)
		// /invite/{code} path'ine gelen crawler'lara zengin preview HTML döner.
		// Normal kullanıcılar SPA'ya yönlendirilir (aşağıdaki fallback).
		if isCrawler(r.UserAgent()) {
			if served := serveInviteOG(w, r, svcs.Invite, cfg.Email.AppURL); served {
				return
			}
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

		// SPA fallback: bilinmeyen path → index.html (absolute path'li versiyon)
		if len(indexHTMLWeb) == 0 {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTMLWeb)
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

	metricsCollector.Stop()
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

// ─── Social Media Crawler OG Meta Tags ───

// invitePathRe, /invite/{hex16} formatını yakalar.
// WhatsApp, Telegram gibi platformlar link paylaşıldığında bu path'e istek atar.
var invitePathRe = regexp.MustCompile(`^/invite/([a-f0-9]{16})$`)

// crawlerPatterns, sosyal medya ve mesajlaşma uygulamalarının bot user-agent'larını içerir.
// Bu crawler'lar JavaScript çalıştırmaz — HTML'deki OG meta tag'lerinden preview oluşturur.
var crawlerPatterns = []string{
	"whatsapp",     // WhatsApp link preview crawler
	"telegrambot",  // Telegram bot (link önizleme)
	"twitterbot",   // Twitter/X card crawler
	"facebookexternalhit", // Facebook Open Graph crawler
	"facebot",      // Facebook bot (alternatif UA)
	"linkedinbot",  // LinkedIn link preview
	"slackbot",     // Slack unfurl bot
	"discordbot",   // Discord embed bot
	"googlebot",    // Google — SEO amaçlı (opsiyonel)
	"bingbot",      // Bing — SEO amaçlı (opsiyonel)
}

// isCrawler, gelen isteğin bir sosyal medya crawler'ından gelip gelmediğini kontrol eder.
// User-Agent header'ı case-insensitive olarak bilinen bot pattern'leriyle eşleştirilir.
func isCrawler(ua string) bool {
	lower := strings.ToLower(ua)
	for _, pattern := range crawlerPatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

// serveInviteOG, /invite/{code} path'indeki crawler isteklerine OG meta tag'li HTML döner.
//
// WhatsApp, Telegram gibi platformlar bir URL paylaşıldığında o URL'ye GET isteği atar
// ve dönen HTML'deki <meta property="og:*"> tag'lerinden zengin önizleme kartı oluşturur.
// SPA (React) client-side rendering kullandığından crawler'lar JavaScript çalıştıramaz —
// bu yüzden server-side olarak minimal HTML döneriz.
//
// Dönen HTML:
//   - og:title  → sunucu adı
//   - og:description → "X üye" bilgisi
//   - og:image → sunucu ikonu (yoksa mqvi logosu)
//   - og:url → davet linki
//   - og:site_name → "mqvi"
//
// Fonksiyon true dönerse response yazılmıştır, false dönerse path /invite/ değildir.
func serveInviteOG(w http.ResponseWriter, r *http.Request, inviteSvc services.InviteService, appURL string) bool {
	matches := invitePathRe.FindStringSubmatch(r.URL.Path)
	if matches == nil {
		return false
	}
	code := matches[1]

	// Preview bilgisini çek — auth gerektirmez
	preview, err := inviteSvc.GetPreview(r.Context(), code)
	if err != nil {
		// Geçersiz/süresi dolmuş davet — crawler'a basit HTML dön
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!DOCTYPE html><html><head>
<meta property="og:title" content="mqvi — Invite">
<meta property="og:description" content="This invite has expired or is invalid">
<meta property="og:site_name" content="mqvi">
</head><body></body></html>`)
		return true
	}

	// OG değerlerini hazırla — XSS koruması için HTML escape
	title := html.EscapeString(preview.ServerName)
	description := fmt.Sprintf("%d members", preview.MemberCount)

	// Sunucu ikonunun tam URL'si — yoksa mqvi logosu
	var imageURL string
	if preview.ServerIconURL != nil && *preview.ServerIconURL != "" {
		if appURL != "" {
			imageURL = appURL + *preview.ServerIconURL
		} else {
			// appURL yoksa relative path ile dene (bazı crawler'lar desteklemez ama en iyi effort)
			imageURL = *preview.ServerIconURL
		}
	} else if appURL != "" {
		imageURL = appURL + "/mqvi-icon-256.png"
	}

	inviteURL := r.URL.Path
	if appURL != "" {
		inviteURL = appURL + r.URL.Path
	}

	// Minimal HTML — sadece OG meta tag'leri
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta property="og:type" content="website">
<meta property="og:site_name" content="mqvi">
<meta property="og:title" content="%s">
<meta property="og:description" content="%s">
<meta property="og:url" content="%s">`,
		title, description, html.EscapeString(inviteURL))

	if imageURL != "" {
		fmt.Fprintf(w, `
<meta property="og:image" content="%s">`, html.EscapeString(imageURL))
	}

	// Twitter Card meta tag'leri — Twitter/X için ayrı gerekir
	fmt.Fprintf(w, `
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="%s">
<meta name="twitter:description" content="%s">`,
		title, description)

	if imageURL != "" {
		fmt.Fprintf(w, `
<meta name="twitter:image" content="%s">`, html.EscapeString(imageURL))
	}

	fmt.Fprint(w, `
</head>
<body></body>
</html>`)

	return true
}
