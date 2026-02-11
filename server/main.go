// Package main, mqvi backend uygulamasının giriş noktasıdır.
//
// Bu dosyanın görevi — Dependency Injection "wire-up":
//   1.  Config'i yükle
//   2.  Database'i başlat
//   3.  i18n çevirilerini yükle
//   4.  Upload dizinini oluştur
//   5.  Repository'leri oluştur (DB bağlantısı ile)
//   6.  WebSocket Hub'ı başlat
//   7.  Service'leri oluştur (repository'ler + hub ile)
//   8.  Handler'ları oluştur (service'ler ile)
//   9.  Middleware'ları oluştur (service + repo'lar ile)
//  10.  HTTP router'ı kur, route'ları bağla
//  11.  CORS yapılandır
//  12.  HTTP Server'ı başlat
//  13.  Graceful shutdown
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
	"strings"
	"syscall"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/middleware"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/i18n"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
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
	_, filename, _, _ := runtime.Caller(0)
	baseDir := filepath.Dir(filename)
	migrationsDir := filepath.Join(baseDir, "database", "migrations")

	db, err := database.New(cfg.Database.Path, migrationsDir)
	if err != nil {
		log.Fatalf("[main] failed to initialize database: %v", err)
	}
	defer db.Close()

	// ─── 3. i18n (Çoklu Dil Desteği) ───
	localesDir := filepath.Join(baseDir, "pkg", "i18n", "locales")
	if err := i18n.Load(localesDir); err != nil {
		log.Fatalf("[main] failed to load i18n translations: %v", err)
	}

	// ─── 4. Upload Dizini ───
	if err := os.MkdirAll(cfg.Upload.Dir, 0755); err != nil {
		log.Fatalf("[main] failed to create upload directory: %v", err)
	}

	// ─── 5. Repository Layer ───
	userRepo := repository.NewSQLiteUserRepo(db.Conn)
	sessionRepo := repository.NewSQLiteSessionRepo(db.Conn)
	roleRepo := repository.NewSQLiteRoleRepo(db.Conn)
	channelRepo := repository.NewSQLiteChannelRepo(db.Conn)
	categoryRepo := repository.NewSQLiteCategoryRepo(db.Conn)
	messageRepo := repository.NewSQLiteMessageRepo(db.Conn)
	attachmentRepo := repository.NewSQLiteAttachmentRepo(db.Conn)
	banRepo := repository.NewSQLiteBanRepo(db.Conn)

	// ─── 6. WebSocket Hub ───
	//
	// Hub, tüm WebSocket bağlantılarını yöneten merkezi yapıdır.
	// `go hub.Run()` ayrı bir goroutine'de event loop başlatır:
	// register/unregister channel'larını dinler ve client map'ini günceller.
	// Hub aynı zamanda EventPublisher interface'ini implement eder —
	// service'ler hub'a doğrudan bağımlı olmak yerine interface üzerinden erişir.
	hub := ws.NewHub()

	// VoiceService — Hub callback'lerinden önce oluşturulmalı çünkü
	// OnUserFullyDisconnected callback'i voice cleanup için voiceService'e ihtiyaç duyar.
	// Dependency'leri (channelRepo, roleRepo, hub, cfg.LiveKit) zaten hazır.
	voiceService := services.NewVoiceService(channelRepo, roleRepo, hub, cfg.LiveKit)

	// Hub presence callback'leri — kullanıcı ilk bağlandığında veya
	// tamamen koptuğunda DB güncelle ve tüm client'lara broadcast et.
	//
	// Bu callback'ler neden burada (main.go'da)?
	// Hub ws paketinde yaşıyor, ama DB güncellemesi service/repo katmanında.
	// Hub'ın service'lere bağımlı olmasını istemiyoruz (Dependency Inversion).
	// main.go wire-up noktasıdır — tüm katmanları birbirine bağlar.
	//
	// Callback'ler Hub.Run() goroutine'inden ayrı goroutine'de çalışır
	// (addClient/removeClient içinde `go callback()` ile çağrılır),
	// böylece Hub'ın mutex Lock'u ile BroadcastToAll'ın RLock'u çakışmaz.
	hub.OnUserFirstConnect(func(userID string) {
		if err := userRepo.UpdateStatus(context.Background(), userID, models.UserStatusOnline); err != nil {
			log.Printf("[presence] failed to set online for user %s: %v", userID, err)
			return
		}
		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(models.UserStatusOnline),
			},
		})
		log.Printf("[presence] user %s is now online", userID)
	})

	hub.OnUserFullyDisconnected(func(userID string) {
		// Presence: kullanıcıyı offline yap
		if err := userRepo.UpdateStatus(context.Background(), userID, models.UserStatusOffline); err != nil {
			log.Printf("[presence] failed to set offline for user %s: %v", userID, err)
			return
		}
		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(models.UserStatusOffline),
			},
		})
		log.Printf("[presence] user %s is now offline", userID)

		// Voice: kullanıcı ses kanalındaysa state'ini temizle ve broadcast et.
		// DisconnectUser içinde LeaveChannel çağrılır — broadcast dahil.
		voiceService.DisconnectUser(userID)
	})

	// Voice callback'leri — client ses kanalı event'leri gönderdiğinde
	// Hub bu callback'leri tetikler, callback'ler voiceService'i çağırır.
	// Presence callback'leri ile aynı pattern (Dependency Inversion).
	hub.OnVoiceJoin(func(userID, username, avatarURL, channelID string) {
		if err := voiceService.JoinChannel(userID, username, avatarURL, channelID); err != nil {
			log.Printf("[voice] join error user=%s channel=%s: %v", userID, channelID, err)
		}
	})
	hub.OnVoiceLeave(func(userID string) {
		if err := voiceService.LeaveChannel(userID); err != nil {
			log.Printf("[voice] leave error user=%s: %v", userID, err)
		}
	})
	hub.OnVoiceStateUpdate(func(userID string, isMuted, isDeafened, isStreaming *bool) {
		if err := voiceService.UpdateState(userID, isMuted, isDeafened, isStreaming); err != nil {
			log.Printf("[voice] state update error user=%s: %v", userID, err)
		}
	})

	go hub.Run()

	// ─── 7. Service Layer ───
	authService := services.NewAuthService(
		userRepo,
		sessionRepo,
		roleRepo,
		banRepo,
		cfg.JWT.Secret,
		cfg.JWT.AccessTokenExpiry,
		cfg.JWT.RefreshTokenExpiry,
	)

	channelService := services.NewChannelService(channelRepo, categoryRepo, hub)
	categoryService := services.NewCategoryService(categoryRepo, hub)
	messageService := services.NewMessageService(messageRepo, attachmentRepo, channelRepo, userRepo, hub)
	uploadService := services.NewUploadService(attachmentRepo, cfg.Upload.Dir, cfg.Upload.MaxSize)
	memberService := services.NewMemberService(userRepo, roleRepo, banRepo, hub)
	roleService := services.NewRoleService(roleRepo, userRepo, hub)
	// voiceService yukarıda (Hub callback'lerinden önce) oluşturuldu

	// ─── 8. Handler Layer ───
	authHandler := handlers.NewAuthHandler(authService)
	channelHandler := handlers.NewChannelHandler(channelService)
	categoryHandler := handlers.NewCategoryHandler(categoryService)
	messageHandler := handlers.NewMessageHandler(messageService, uploadService, cfg.Upload.MaxSize)
	memberHandler := handlers.NewMemberHandler(memberService)
	roleHandler := handlers.NewRoleHandler(roleService)
	voiceHandler := handlers.NewVoiceHandler(voiceService)
	wsHandler := ws.NewHandler(hub, authService, memberService, voiceService)

	// ─── 9. Middleware ───
	authMiddleware := middleware.NewAuthMiddleware(authService, userRepo)
	permMiddleware := middleware.NewPermissionMiddleware(roleRepo)

	// ─── 10. HTTP Router ───
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

	// Channels — List herkese açık, CUD için MANAGE_CHANNELS yetkisi gerekir
	mux.Handle("GET /api/channels", authMiddleware.Require(
		http.HandlerFunc(channelHandler.List)))
	mux.Handle("POST /api/channels", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(channelHandler.Create))))
	mux.Handle("PATCH /api/channels/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(channelHandler.Update))))
	mux.Handle("DELETE /api/channels/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(channelHandler.Delete))))

	// Categories — List herkese açık, CUD için MANAGE_CHANNELS yetkisi gerekir
	mux.Handle("GET /api/categories", authMiddleware.Require(
		http.HandlerFunc(categoryHandler.List)))
	mux.Handle("POST /api/categories", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(categoryHandler.Create))))
	mux.Handle("PATCH /api/categories/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(categoryHandler.Update))))
	mux.Handle("DELETE /api/categories/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(categoryHandler.Delete))))

	// Messages — tüm authenticated kullanıcılar mesaj okuyup yazabilir
	mux.Handle("GET /api/channels/{id}/messages", authMiddleware.Require(
		http.HandlerFunc(messageHandler.List)))
	mux.Handle("POST /api/channels/{id}/messages", authMiddleware.Require(
		http.HandlerFunc(messageHandler.Create)))
	mux.Handle("PATCH /api/messages/{id}", authMiddleware.Require(
		http.HandlerFunc(messageHandler.Update)))
	mux.Handle("DELETE /api/messages/{id}", authMiddleware.Require(
		http.HandlerFunc(messageHandler.Delete)))

	// Upload — bağımsız dosya yükleme endpoint'i
	mux.Handle("POST /api/upload", authMiddleware.Require(
		http.HandlerFunc(messageHandler.Upload)))

	// Members — üye listesi herkese açık, moderation işlemleri yetki gerektirir
	mux.Handle("GET /api/members", authMiddleware.Require(
		http.HandlerFunc(memberHandler.List)))
	mux.Handle("GET /api/members/{id}", authMiddleware.Require(
		http.HandlerFunc(memberHandler.Get)))
	mux.Handle("PATCH /api/members/{id}/roles", authMiddleware.Require(
		permMiddleware.Require(models.PermManageRoles, http.HandlerFunc(memberHandler.ModifyRoles))))
	mux.Handle("DELETE /api/members/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermKickMembers, http.HandlerFunc(memberHandler.Kick))))
	mux.Handle("POST /api/members/{id}/ban", authMiddleware.Require(
		permMiddleware.Require(models.PermBanMembers, http.HandlerFunc(memberHandler.Ban))))

	// Bans — yasaklı üye yönetimi, BAN_MEMBERS yetkisi gerektirir
	mux.Handle("GET /api/bans", authMiddleware.Require(
		permMiddleware.Require(models.PermBanMembers, http.HandlerFunc(memberHandler.GetBans))))
	mux.Handle("DELETE /api/bans/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermBanMembers, http.HandlerFunc(memberHandler.Unban))))

	// Profile — kullanıcının kendi profil güncelleme endpoint'i
	mux.Handle("PATCH /api/users/me/profile", authMiddleware.Require(
		http.HandlerFunc(memberHandler.UpdateProfile)))

	// Roles — rol listesi herkese açık, CUD için MANAGE_ROLES yetkisi gerekir
	mux.Handle("GET /api/roles", authMiddleware.Require(
		http.HandlerFunc(roleHandler.List)))
	mux.Handle("POST /api/roles", authMiddleware.Require(
		permMiddleware.Require(models.PermManageRoles, http.HandlerFunc(roleHandler.Create))))
	mux.Handle("PATCH /api/roles/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageRoles, http.HandlerFunc(roleHandler.Update))))
	mux.Handle("DELETE /api/roles/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageRoles, http.HandlerFunc(roleHandler.Delete))))

	// Voice — LiveKit token alma ve aktif ses durumlarını sorgulama
	//
	// Token endpoint, kullanıcının voice kanala bağlanmak için ihtiyaç duyduğu
	// LiveKit JWT'sini döner. Permission kontrolü service katmanında yapılır
	// (PermConnectVoice, PermSpeak, PermStream ayrı ayrı kontrol edilip
	// LiveKit token grant'larına yansıtılır).
	mux.Handle("POST /api/voice/token", authMiddleware.Require(
		http.HandlerFunc(voiceHandler.Token)))
	mux.Handle("GET /api/voice/states", authMiddleware.Require(
		http.HandlerFunc(voiceHandler.VoiceStates)))

	// Static file serving — yüklenen dosyalara erişim
	//
	// http.StripPrefix: URL'den "/api/uploads/" kısmını çıkarır.
	// http.FileServer: Kalan path'i upload dizininde dosya olarak arar.
	// Örnek: GET /api/uploads/abc123_photo.jpg → ./data/uploads/abc123_photo.jpg
	//
	// Path traversal koruması:
	// http.FileServer zaten ".." path'lerini reddeder.
	// Ek güvenlik için sadece dosya isimlerini kabul edip subdirectory'leri reddediyoruz.
	uploadsHandler := http.StripPrefix("/api/uploads/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Güvenlik: sadece düz dosya isimlerini kabul et, subdirectory traversal'ı engelle
		if strings.Contains(r.URL.Path, "/") || strings.Contains(r.URL.Path, "\\") {
			http.NotFound(w, r)
			return
		}
		http.FileServer(http.Dir(cfg.Upload.Dir)).ServeHTTP(w, r)
	}))
	mux.Handle("GET /api/uploads/", uploadsHandler)

	// WebSocket — token query parameter ile authenticate edilir
	//
	// Neden auth middleware kullanmıyoruz?
	// WebSocket upgrade sırasında tarayıcılar custom HTTP header gönderemez.
	// Bu yüzden JWT token URL query parameter olarak gönderilir:
	//   ws://server/ws?token=JWT_TOKEN
	// WS handler kendi içinde token doğrulaması yapar.
	mux.HandleFunc("GET /ws", wsHandler.HandleConnection)

	// ─── 11. CORS ───
	corsHandler := cors.New(cors.Options{
		AllowedOrigins: []string{
			"http://localhost:3000",  // Vite dev server
			"http://localhost:1420",  // Tauri dev
			"tauri://localhost",      // Tauri production
		},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
		Debug:            false,
	})

	handler := corsHandler.Handler(mux)

	// ─── 12. HTTP Server ───
	srv := &http.Server{
		Addr:         cfg.Server.Addr(),
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// ─── 13. Graceful Shutdown ───
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

	// Önce WebSocket bağlantılarını kapat — client'lar "server shutting down" bilir.
	// Sonra HTTP server'ı kapat — yeni request kabul etmeyi durdurur,
	// mevcut request'lerin bitmesini bekler (5sn timeout).
	hub.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("[main] forced shutdown: %v", err)
	}

	log.Println("[main] server stopped gracefully")
}
