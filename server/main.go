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
	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/middleware"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/i18n"
	"github.com/akinalp/mqvi/repository"
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
	// Migration dosyaları binary'ye gömülü (embed.FS).
	// fs.Sub ile "migrations/" alt dizinine erişiyoruz — dosya isimleri
	// doğrudan "001_init.sql" olarak okunabilir.
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		log.Fatalf("[main] failed to access embedded migrations: %v", err)
	}

	db, err := database.New(cfg.Database.Path, migrationsFS)
	if err != nil {
		log.Fatalf("[main] failed to initialize database: %v", err)
	}
	defer db.Close()

	// ─── 3. i18n (Çoklu Dil Desteği) ───
	// Çeviri JSON dosyaları binary'ye gömülü (embed.FS).
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
	userRepo := repository.NewSQLiteUserRepo(db.Conn)
	sessionRepo := repository.NewSQLiteSessionRepo(db.Conn)
	roleRepo := repository.NewSQLiteRoleRepo(db.Conn)
	channelRepo := repository.NewSQLiteChannelRepo(db.Conn)
	categoryRepo := repository.NewSQLiteCategoryRepo(db.Conn)
	messageRepo := repository.NewSQLiteMessageRepo(db.Conn)
	attachmentRepo := repository.NewSQLiteAttachmentRepo(db.Conn)
	banRepo := repository.NewSQLiteBanRepo(db.Conn)
	serverRepo := repository.NewSQLiteServerRepo(db.Conn)
	inviteRepo := repository.NewSQLiteInviteRepo(db.Conn)
	pinRepo := repository.NewSQLitePinRepo(db.Conn)
	searchRepo := repository.NewSQLiteSearchRepo(db.Conn)
	readStateRepo := repository.NewSQLiteReadStateRepo(db.Conn)
	mentionRepo := repository.NewSQLiteMentionRepo(db.Conn)
	dmRepo := repository.NewSQLiteDMRepo(db.Conn)
	reactionRepo := repository.NewSQLiteReactionRepo(db.Conn)
	channelPermRepo := repository.NewSQLiteChannelPermRepo(db.Conn)
	friendshipRepo := repository.NewSQLiteFriendshipRepo(db.Conn)

	// ─── 6. WebSocket Hub ───
	//
	// Hub, tüm WebSocket bağlantılarını yöneten merkezi yapıdır.
	// `go hub.Run()` ayrı bir goroutine'de event loop başlatır:
	// register/unregister channel'larını dinler ve client map'ini günceller.
	// Hub aynı zamanda EventPublisher interface'ini implement eder —
	// service'ler hub'a doğrudan bağımlı olmak yerine interface üzerinden erişir.
	hub := ws.NewHub()

	// ChannelPermissionService — VoiceService ve MessageService'den ÖNCE oluşturulmalı,
	// çünkü ikisi de kanal bazlı permission resolution için buna bağımlı.
	channelPermService := services.NewChannelPermissionService(channelPermRepo, roleRepo, hub)

	// VoiceService — Hub callback'lerinden önce oluşturulmalı çünkü
	// OnUserFullyDisconnected callback'i voice cleanup için voiceService'e ihtiyaç duyar.
	// channelPermService kanal bazlı permission resolution sağlar (rol + override).
	voiceService := services.NewVoiceService(channelRepo, channelPermService, hub, cfg.LiveKit)

	// P2PCallService — Hub callback'lerinden önce oluşturulmalı.
	// Arkadaşlık kontrolü için friendshipRepo, kullanıcı bilgisi için userRepo kullanır.
	// In-memory state: aktif aramalar ve kullanıcı-arama eşleştirmesi.
	p2pCallService := services.NewP2PCallService(friendshipRepo, userRepo, hub)

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

		// P2P Call: kullanıcı aktif bir P2P aramadaysa sonlandır.
		// Karşı tarafa p2p_call_end event'i gönderilir.
		p2pCallService.HandleDisconnect(userID)
	})

	// Presence manual update callback'i — client idle/dnd gibi durum değişikliği
	// gönderdiğinde DB'ye persist et ve tüm client'lara broadcast et.
	//
	// Bu callback handlePresenceUpdate'ten (client.go) çağrılır.
	// OnUserFirstConnect/OnUserFullyDisconnected ile aynı pattern:
	// DB güncelleme + BroadcastToAll.
	hub.OnPresenceManualUpdate(func(userID string, status string) {
		if err := userRepo.UpdateStatus(context.Background(), userID, models.UserStatus(status)); err != nil {
			log.Printf("[presence] failed to set %s for user %s: %v", status, userID, err)
			return
		}
		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: status,
			},
		})
		log.Printf("[presence] user %s is now %s (manual)", userID, status)
	})

	// Voice callback'leri — client ses kanalı event'leri gönderdiğinde
	// Hub bu callback'leri tetikler, callback'ler voiceService'i çağırır.
	// Presence callback'leri ile aynı pattern (Dependency Inversion).
	hub.OnVoiceJoin(func(userID, username, displayName, avatarURL, channelID string) {
		if err := voiceService.JoinChannel(userID, username, displayName, avatarURL, channelID); err != nil {
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
	hub.OnVoiceAdminStateUpdate(func(adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) {
		if err := voiceService.AdminUpdateState(context.Background(), adminUserID, targetUserID, isServerMuted, isServerDeafened); err != nil {
			log.Printf("[voice] admin state update error admin=%s target=%s: %v", adminUserID, targetUserID, err)
		}
	})

	// P2P Call callback'leri — client P2P arama event'leri gönderdiğinde
	// Hub bu callback'leri tetikler, callback'ler p2pCallService'i çağırır.
	hub.OnP2PCallInitiate(func(callerID string, data ws.P2PCallInitiateData) {
		callType := models.P2PCallType(data.CallType)
		if err := p2pCallService.InitiateCall(callerID, data.ReceiverID, callType); err != nil {
			log.Printf("[p2p] initiate error caller=%s receiver=%s: %v", callerID, data.ReceiverID, err)
		}
	})
	hub.OnP2PCallAccept(func(userID string, data ws.P2PCallAcceptData) {
		if err := p2pCallService.AcceptCall(userID, data.CallID); err != nil {
			log.Printf("[p2p] accept error user=%s call=%s: %v", userID, data.CallID, err)
		}
	})
	hub.OnP2PCallDecline(func(userID string, data ws.P2PCallDeclineData) {
		if err := p2pCallService.DeclineCall(userID, data.CallID); err != nil {
			log.Printf("[p2p] decline error user=%s call=%s: %v", userID, data.CallID, err)
		}
	})
	hub.OnP2PCallEnd(func(userID string) {
		if err := p2pCallService.EndCall(userID); err != nil {
			log.Printf("[p2p] end error user=%s: %v", userID, err)
		}
	})
	hub.OnP2PSignal(func(senderID string, data ws.P2PSignalData) {
		if err := p2pCallService.RelaySignal(senderID, data.CallID, data); err != nil {
			log.Printf("[p2p] signal relay error sender=%s call=%s: %v", senderID, data.CallID, err)
		}
	})

	go hub.Run()

	// ─── 7. Service Layer ───
	//
	// InviteService, AuthService'den ÖNCE oluşturulmalı — AuthService buna bağımlı.
	// (Register sırasında davet kodu doğrulaması için InviteService kullanılır)
	inviteService := services.NewInviteService(inviteRepo, serverRepo)

	authService := services.NewAuthService(
		userRepo,
		sessionRepo,
		roleRepo,
		banRepo,
		inviteService,
		hub,
		cfg.JWT.Secret,
		cfg.JWT.AccessTokenExpiry,
		cfg.JWT.RefreshTokenExpiry,
	)

	channelService := services.NewChannelService(channelRepo, categoryRepo, hub)
	categoryService := services.NewCategoryService(categoryRepo, hub)
	messageService := services.NewMessageService(messageRepo, attachmentRepo, channelRepo, userRepo, mentionRepo, reactionRepo, hub, channelPermService)
	uploadService := services.NewUploadService(attachmentRepo, cfg.Upload.Dir, cfg.Upload.MaxSize)
	memberService := services.NewMemberService(userRepo, roleRepo, banRepo, hub)
	roleService := services.NewRoleService(roleRepo, userRepo, hub)
	serverService := services.NewServerService(serverRepo, hub)
	pinService := services.NewPinService(pinRepo, messageRepo, hub)
	searchService := services.NewSearchService(searchRepo)
	readStateService := services.NewReadStateService(readStateRepo)
	dmService := services.NewDMService(dmRepo, userRepo, hub)
	reactionService := services.NewReactionService(reactionRepo, messageRepo, hub)
	friendshipService := services.NewFriendshipService(friendshipRepo, userRepo, hub)
	// voiceService ve channelPermService yukarıda (Hub callback'lerinden önce) oluşturuldu

	// ─── 8. Handler Layer ───
	authHandler := handlers.NewAuthHandler(authService)
	channelHandler := handlers.NewChannelHandler(channelService)
	categoryHandler := handlers.NewCategoryHandler(categoryService)
	messageHandler := handlers.NewMessageHandler(messageService, uploadService, cfg.Upload.MaxSize)
	memberHandler := handlers.NewMemberHandler(memberService)
	roleHandler := handlers.NewRoleHandler(roleService)
	voiceHandler := handlers.NewVoiceHandler(voiceService)
	serverHandler := handlers.NewServerHandler(serverService)
	inviteHandler := handlers.NewInviteHandler(inviteService)
	pinHandler := handlers.NewPinHandler(pinService)
	searchHandler := handlers.NewSearchHandler(searchService)
	readStateHandler := handlers.NewReadStateHandler(readStateService)
	dmHandler := handlers.NewDMHandler(dmService)
	reactionHandler := handlers.NewReactionHandler(reactionService)
	channelPermHandler := handlers.NewChannelPermissionHandler(channelPermService)
	friendshipHandler := handlers.NewFriendshipHandler(friendshipService)
	avatarHandler := handlers.NewAvatarHandler(userRepo, memberService, serverService, cfg.Upload.Dir)
	statsHandler := handlers.NewStatsHandler(userRepo)
	wsHandler := ws.NewHandler(hub, authService, memberService, voiceService, userRepo)

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

	// Stats — public endpoint (auth gerekmez, landing page kullanır)
	mux.HandleFunc("GET /api/stats", statsHandler.GetPublicStats)

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
	// Reorder route'u {id} parametreli route'lardan ÖNCE tanımlanmalı —
	// yoksa Go router "reorder" kelimesini bir {id} olarak yorumlar.
	mux.Handle("PATCH /api/channels/reorder", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(channelHandler.Reorder))))
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
		permMiddleware.Load(http.HandlerFunc(messageHandler.Delete))))

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

	// Avatar — kullanıcı avatar yükleme endpoint'i
	// Ayrı bir handler çünkü multipart form parse ve resim validasyonu
	// mevcut UploadService'den farklıdır (message attachment'a bağlı değil).
	mux.Handle("POST /api/users/me/avatar", authMiddleware.Require(
		http.HandlerFunc(avatarHandler.UploadUserAvatar)))

	// Server — sunucu bilgileri, ikon yükleme
	// Get herkese açık (authenticated), Update/Icon Admin yetkisi gerektirir
	mux.Handle("GET /api/server", authMiddleware.Require(
		http.HandlerFunc(serverHandler.Get)))
	mux.Handle("PATCH /api/server", authMiddleware.Require(
		permMiddleware.Require(models.PermAdmin, http.HandlerFunc(serverHandler.Update))))
	mux.Handle("POST /api/server/icon", authMiddleware.Require(
		permMiddleware.Require(models.PermAdmin, http.HandlerFunc(avatarHandler.UploadServerIcon))))

	// Invites — davet kodu yönetimi, ManageInvites yetkisi gerektirir
	mux.Handle("GET /api/invites", authMiddleware.Require(
		permMiddleware.Require(models.PermManageInvites, http.HandlerFunc(inviteHandler.List))))
	mux.Handle("POST /api/invites", authMiddleware.Require(
		permMiddleware.Require(models.PermManageInvites, http.HandlerFunc(inviteHandler.Create))))
	mux.Handle("DELETE /api/invites/{code}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageInvites, http.HandlerFunc(inviteHandler.Delete))))

	// Search — FTS5 tam metin arama, authenticated kullanıcılar kullanabilir
	mux.Handle("GET /api/search", authMiddleware.Require(
		http.HandlerFunc(searchHandler.Search)))

	// Pins — mesaj sabitleme, ManageMessages yetkisi gerekir (list herkese açık)
	mux.Handle("GET /api/channels/{id}/pins", authMiddleware.Require(
		http.HandlerFunc(pinHandler.ListPins)))
	mux.Handle("POST /api/channels/{channelId}/messages/{messageId}/pin", authMiddleware.Require(
		permMiddleware.Require(models.PermManageMessages, http.HandlerFunc(pinHandler.Pin))))
	mux.Handle("DELETE /api/channels/{channelId}/messages/{messageId}/pin", authMiddleware.Require(
		permMiddleware.Require(models.PermManageMessages, http.HandlerFunc(pinHandler.Unpin))))

	// Reactions — emoji tepkileri, tüm authenticated kullanıcılar kullanabilir
	// Toggle: Aynı emoji ile tekrar çağrılırsa reaction kaldırılır (toggle pattern)
	// Emoji body'de gönderilir (URL path'te encoding sorunları yaratabilir)
	mux.Handle("POST /api/messages/{messageId}/reactions", authMiddleware.Require(
		http.HandlerFunc(reactionHandler.Toggle)))

	// Read State — okunmamış mesaj takibi, authenticated kullanıcılar kullanabilir
	// MarkRead: kanal değiştirdiğinde frontend otomatik çağırır (auto-mark-read)
	// GetUnreads: uygulama başlangıcında ve WS reconnect'te çağrılır
	mux.Handle("POST /api/channels/{id}/read", authMiddleware.Require(
		http.HandlerFunc(readStateHandler.MarkRead)))
	mux.Handle("GET /api/channels/unread", authMiddleware.Require(
		http.HandlerFunc(readStateHandler.GetUnreads)))

	// Roles — rol listesi herkese açık, CUD için MANAGE_ROLES yetkisi gerekir
	mux.Handle("GET /api/roles", authMiddleware.Require(
		http.HandlerFunc(roleHandler.List)))
	mux.Handle("POST /api/roles", authMiddleware.Require(
		permMiddleware.Require(models.PermManageRoles, http.HandlerFunc(roleHandler.Create))))
	mux.Handle("PATCH /api/roles/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageRoles, http.HandlerFunc(roleHandler.Update))))
	mux.Handle("DELETE /api/roles/{id}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageRoles, http.HandlerFunc(roleHandler.Delete))))

	// Channel Permissions — kanal bazlı permission override yönetimi
	// List herkese açık (authenticated), CUD için ManageChannels yetkisi gerekir
	mux.Handle("GET /api/channels/{id}/permissions", authMiddleware.Require(
		http.HandlerFunc(channelPermHandler.ListOverrides)))
	mux.Handle("PUT /api/channels/{channelId}/permissions/{roleId}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(channelPermHandler.SetOverride))))
	mux.Handle("DELETE /api/channels/{channelId}/permissions/{roleId}", authMiddleware.Require(
		permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(channelPermHandler.DeleteOverride))))

	// DMs — Direct Messages, authenticated kullanıcılar arası özel mesajlaşma
	mux.Handle("GET /api/dms", authMiddleware.Require(
		http.HandlerFunc(dmHandler.ListChannels)))
	mux.Handle("POST /api/dms", authMiddleware.Require(
		http.HandlerFunc(dmHandler.CreateOrGetChannel)))
	mux.Handle("GET /api/dms/{channelId}/messages", authMiddleware.Require(
		http.HandlerFunc(dmHandler.GetMessages)))
	mux.Handle("POST /api/dms/{channelId}/messages", authMiddleware.Require(
		http.HandlerFunc(dmHandler.SendMessage)))
	mux.Handle("PATCH /api/dms/messages/{id}", authMiddleware.Require(
		http.HandlerFunc(dmHandler.EditMessage)))
	mux.Handle("DELETE /api/dms/messages/{id}", authMiddleware.Require(
		http.HandlerFunc(dmHandler.DeleteMessage)))

	// Friends — arkadaşlık yönetimi, tüm authenticated kullanıcılar kullanabilir
	// "requests" literal path'i {userId} parametresinden ÖNCE tanımlanmalı —
	// yoksa Go router "requests" kelimesini bir {userId} olarak yorumlar.
	mux.Handle("GET /api/friends/requests", authMiddleware.Require(
		http.HandlerFunc(friendshipHandler.ListRequests)))
	mux.Handle("POST /api/friends/requests", authMiddleware.Require(
		http.HandlerFunc(friendshipHandler.SendRequest)))
	mux.Handle("POST /api/friends/requests/{id}/accept", authMiddleware.Require(
		http.HandlerFunc(friendshipHandler.AcceptRequest)))
	mux.Handle("DELETE /api/friends/requests/{id}", authMiddleware.Require(
		http.HandlerFunc(friendshipHandler.DeclineRequest)))
	mux.Handle("GET /api/friends", authMiddleware.Require(
		http.HandlerFunc(friendshipHandler.ListFriends)))
	mux.Handle("DELETE /api/friends/{userId}", authMiddleware.Require(
		http.HandlerFunc(friendshipHandler.RemoveFriend)))

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

	// ─── 11. SPA Frontend Serving ───
	//
	// React frontend build çıktısı binary'ye gömülü (embed.FS).
	// /api/* ve /ws dışındaki tüm request'ler frontend'e yönlendirilir.
	// SPA (Single Page Application) routing: bilinmeyen path'ler → index.html
	//
	// Bu handler sadece production build'de çalışır. Development'ta
	// dist/ içi boştur (.gitkeep) ve Vite dev server frontend'i servis eder.
	frontendFS, err := fs.Sub(static.FrontendFS, "dist")
	if err != nil {
		log.Fatalf("[main] failed to access embedded frontend: %v", err)
	}
	// index.html var mı kontrol et — yoksa development modundayız (frontend embed edilmemiş).
	hasFrontend := false
	if f, checkErr := frontendFS.(fs.ReadFileFS).ReadFile("index.html"); checkErr == nil && len(f) > 0 {
		hasFrontend = true
		log.Println("[main] embedded frontend detected, SPA serving enabled")
	} else {
		log.Println("[main] no embedded frontend, API-only mode (use Vite dev server for frontend)")
	}

	// ─── 12. CORS ───
	//
	// CORS_ORIGINS env variable ile ek origin'ler eklenebilir (virgülle ayrılmış).
	// Production'da frontend aynı origin'den servis edilir — CORS gerekmez.
	// Ama Tauri desktop client ve development için CORS hâlâ gerekli.
	corsOrigins := []string{
		"http://localhost:3030",  // Vite dev server
		"http://localhost:1420",  // Tauri dev
		"tauri://localhost",      // Tauri production
	}
	if extra := os.Getenv("CORS_ORIGINS"); extra != "" {
		for _, origin := range strings.Split(extra, ",") {
			origin = strings.TrimSpace(origin)
			if origin != "" {
				corsOrigins = append(corsOrigins, origin)
			}
		}
	}
	corsHandler := cors.New(cors.Options{
		AllowedOrigins:   corsOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
		Debug:            false,
	})

	// ─── 13. Final Handler ───
	//
	// Request akışı: CORS → API/WS mux VEYA SPA frontend
	// /api/* ve /ws → normal mux (API handler'lar)
	// Diğer path'ler → embedded frontend (SPA fallback)
	apiHandler := corsHandler.Handler(mux)

	finalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// API ve WebSocket route'ları → normal mux
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" {
			apiHandler.ServeHTTP(w, r)
			return
		}

		// Frontend embed edilmemişse (development) → 404
		if !hasFrontend {
			apiHandler.ServeHTTP(w, r)
			return
		}

		// Static dosya var mı? (JS, CSS, resimler vb.)
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
		// React Router client-side routing'i devralır.
		indexData, readErr := fs.ReadFile(frontendFS, "index.html")
		if readErr != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexData)
	})

	// ─── 14. HTTP Server ───
	srv := &http.Server{
		Addr:         cfg.Server.Addr(),
		Handler:      finalHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// ─── 15. Graceful Shutdown ───
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
