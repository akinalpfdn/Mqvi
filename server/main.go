package main

import (
	"context"
	"fmt"
	"html"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
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

func init() {
	// Windows registry can return wrong MIME types for some extensions.
	// Force correct values so http.FileServer serves them properly.
	mime.AddExtensionType(".svg", "image/svg+xml")
	mime.AddExtensionType(".wasm", "application/wasm")
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".css", "text/css")
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Println("[main] mqvi server starting...")

	// 1. Config
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[main] failed to load config: %v", err)
	}
	log.Printf("[main] config loaded (port=%d)", cfg.Server.Port)

	// 2. Database
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		log.Fatalf("[main] failed to access embedded migrations: %v", err)
	}

	db, err := database.New(cfg.Database.Path, migrationsFS)
	if err != nil {
		log.Fatalf("[main] failed to initialize database: %v", err)
	}
	defer db.Close()

	// 3. i18n
	localesFS, err := fs.Sub(i18n.EmbeddedLocales, "locales")
	if err != nil {
		log.Fatalf("[main] failed to access embedded locales: %v", err)
	}
	if err := i18n.Load(localesFS); err != nil {
		log.Fatalf("[main] failed to load i18n translations: %v", err)
	}

	// 4. Upload directory
	if err := os.MkdirAll(cfg.Upload.Dir, 0755); err != nil {
		log.Fatalf("[main] failed to create upload directory: %v", err)
	}

	// 5. Repository layer
	repos := initRepositories(db.Conn)

	// 6. Encryption key
	encryptionKey, err := crypto.DeriveKey(cfg.EncryptionKey)
	if err != nil {
		log.Fatalf("[main] invalid ENCRYPTION_KEY: %v", err)
	}

	// 7. Startup cleanup + presence reset + LiveKit seed
	runStartupCleanup(db, repos, cfg, encryptionKey)

	// 8. WebSocket Hub
	hub := ws.NewHub()

	// 9. Service layer (order matters: channelPerm -> voice -> p2pCall -> rest)
	svcs, limiters, metricsCollector := initServices(db.Conn, repos, hub, cfg, encryptionKey)

	// 9b. Wire structured app logger into Hub and services
	hub.SetAppLogger(svcs.AppLog)
	svcs.Voice.SetAppLogger(svcs.AppLog)
	svcs.P2PCall.SetAppLogger(svcs.AppLog)
	svcs.Auth.SetAppLogger(svcs.AppLog)

	// 10. Hub callbacks (must be after services, before hub.Run)
	registerHubCallbacks(hub, repos.User, repos.DM, svcs.Voice, svcs.P2PCall, repos.Channel, repos.Server, svcs.ChannelPermission)

	go hub.Run()

	// Voice orphan cleanup — periodic sweep for stale voice states (30s interval)
	svcs.Voice.StartOrphanCleanup()

	// Voice AFK checker — kicks idle users based on per-server timeout
	svcs.Voice.StartAFKChecker()

	// 10b. Metrics collector — background goroutine polling LiveKit instances
	metricsCollector.Start()

	// 10c. App log service — async writer + auto-purge (30 days)
	svcs.AppLog.Start()

	// 11. Handler layer
	h := initHandlers(svcs, repos, limiters, hub, cfg, encryptionKey)

	// 12. HTTP router + routes
	mux := http.NewServeMux()
	initRoutes(mux, h, svcs.Auth, repos.User, repos.Role, repos.Server)

	// 13. Static file serving
	registerStaticAndUploads(mux, cfg)

	// 14. SPA frontend serving
	frontendFS, hasFrontend := initFrontendFS()

	// Rewrite relative paths in index.html for web serving.
	// Vite builds with base "./" for Electron file:// compat, but web needs "/".
	var indexHTMLWeb []byte
	if hasFrontend {
		raw, readErr := fs.ReadFile(frontendFS, "index.html")
		if readErr == nil {
			indexHTMLWeb = []byte(strings.ReplaceAll(string(raw), `"./`, `"/`))
		}
	}

	// 15. CORS (shared origin whitelist for both HTTP CORS and WebSocket upgrade)
	corsHandler, corsOrigins := initCORS(cfg)
	ws.AllowedOrigins = corsOrigins

	// 16. Final handler
	apiHandler := corsHandler.Handler(mux)

	finalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WebSocket upgrade bypasses CORS middleware — ws.CheckOrigin handles its own origin validation
		if r.URL.Path == "/ws" {
			mux.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/static/") {
			apiHandler.ServeHTTP(w, r)
			return
		}

		if !hasFrontend {
			apiHandler.ServeHTTP(w, r)
			return
		}

		// OG meta tags for social media crawlers on /invite/{code}
		if isCrawler(r.UserAgent()) {
			if served := serveInviteOG(w, r, svcs.Invite, cfg.Email.AppURL); served {
				return
			}
		}

		// Try static file first
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if f, openErr := frontendFS.Open(path); openErr == nil {
			f.Close()
			http.FileServer(http.FS(frontendFS)).ServeHTTP(w, r)
			return
		}

		// SPA fallback
		if len(indexHTMLWeb) == 0 {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTMLWeb)
	})

	// 17. Security headers
	securedHandler := securityHeaders(finalHandler)

	// 18. HTTP Server
	srv := &http.Server{
		Addr:         cfg.Server.Addr(),
		Handler:      securedHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// 19. Graceful shutdown
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

	svcs.AppLog.Stop()
	metricsCollector.Stop()
	hub.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("[main] forced shutdown: %v", err)
	}

	log.Println("[main] server stopped gracefully")
}

// ─── Startup Helpers ───

// runStartupCleanup handles one-time DB cleanup and seeding at boot.
func runStartupCleanup(db *database.DB, repos *Repositories, cfg *config.Config, encryptionKey []byte) {
	// Fix empty-ID LiveKit instances
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

		// Fix empty-ID servers
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

	// Reset stale presence to offline
	{
		result, resetErr := db.Conn.ExecContext(context.Background(),
			`UPDATE users SET status = 'offline' WHERE status IN ('online', 'idle')`)
		if resetErr != nil {
			log.Printf("[main] warning: failed to reset stale presence: %v", resetErr)
		} else if affected, _ := result.RowsAffected(); affected > 0 {
			log.Printf("[main] reset %d stale user status(es) to offline", affected)
		}
	}

	// Seed platform LiveKit instance
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

// registerStaticAndUploads sets up the upload file serving endpoint.
func registerStaticAndUploads(mux *http.ServeMux, cfg *config.Config) {
	uploadsHandler := http.StripPrefix("/api/uploads/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Block path traversal but allow one level of subdirectory (e.g. soundboard/)
		if strings.Contains(r.URL.Path, "\\") || strings.Contains(r.URL.Path, "..") {
			http.NotFound(w, r)
			return
		}
		// Reject any request that targets a directory — prevents directory listing
		// disclosure (Go's http.FileServer auto-renders index of files otherwise).
		if r.URL.Path == "" || r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		fullPath := filepath.Join(cfg.Upload.Dir, filepath.FromSlash(r.URL.Path))
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		http.FileServer(http.Dir(cfg.Upload.Dir)).ServeHTTP(w, r)
	}))
	mux.Handle("GET /api/uploads/", uploadsHandler)

	// Landing page assets (video, screenshots) — public, no auth
	landingDir := cfg.Upload.Dir + "/../landing"
	landingHandler := http.StripPrefix("/static/landing/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "" || strings.Contains(r.URL.Path, "/") || strings.Contains(r.URL.Path, "\\") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.FileServer(http.Dir(landingDir)).ServeHTTP(w, r)
	}))
	mux.Handle("GET /static/landing/", landingHandler)

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","service":"mqvi"}`)
	})
}

// initFrontendFS loads the embedded frontend. Returns false if no frontend is embedded.
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

func initCORS(cfg *config.Config) (*cors.Cors, []string) {
	corsOrigins := []string{
		"http://localhost:3030",
		"http://localhost:1420",
		"capacitor://localhost",  // iOS Capacitor WKWebView
		"ionic://localhost",      // iOS Capacitor (legacy scheme)
		"http://localhost",       // Android Capacitor WebView (legacy)
		"https://localhost",      // Android Capacitor WebView (Capacitor 6+)
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
	}), corsOrigins
}

// securityHeaders wraps a handler with standard HTTP security headers.
// Applied to all responses (API + static + SPA).
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=()")
		next.ServeHTTP(w, r)
	})
}

// ─── Social Media Crawler OG Meta Tags ───

var invitePathRe = regexp.MustCompile(`^/invite/([a-f0-9]{16})$`)

var crawlerPatterns = []string{
	"whatsapp", "telegrambot", "twitterbot", "facebookexternalhit",
	"facebot", "linkedinbot", "slackbot", "discordbot",
	"googlebot", "bingbot",
}

func isCrawler(ua string) bool {
	lower := strings.ToLower(ua)
	for _, pattern := range crawlerPatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

// serveInviteOG returns OG meta tag HTML for /invite/{code} crawler requests.
// Social media crawlers can't execute JS, so we serve a minimal HTML with meta tags.
// Returns true if the response was written.
func serveInviteOG(w http.ResponseWriter, r *http.Request, inviteSvc services.InviteService, appURL string) bool {
	matches := invitePathRe.FindStringSubmatch(r.URL.Path)
	if matches == nil {
		return false
	}
	code := matches[1]

	preview, err := inviteSvc.GetPreview(r.Context(), code)
	if err != nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!DOCTYPE html><html><head>
<meta property="og:title" content="mqvi — Invite">
<meta property="og:description" content="This invite has expired or is invalid">
<meta property="og:site_name" content="mqvi">
</head><body></body></html>`)
		return true
	}

	title := html.EscapeString(preview.ServerName)
	description := fmt.Sprintf("%d members", preview.MemberCount)

	var imageURL string
	if preview.ServerIconURL != nil && *preview.ServerIconURL != "" {
		if appURL != "" {
			imageURL = appURL + *preview.ServerIconURL
		} else {
			imageURL = *preview.ServerIconURL
		}
	} else if appURL != "" {
		imageURL = appURL + "/mqvi-icon-256.png"
	}

	inviteURL := r.URL.Path
	if appURL != "" {
		inviteURL = appURL + r.URL.Path
	}

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
