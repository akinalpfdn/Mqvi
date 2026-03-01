// Package main, mqvi backend uygulamasının giriş noktasıdır.
//
// Bu dosyanın görevi — Dependency Injection "wire-up":
//   1.  Config'i yükle
//   2.  Database'i başlat
//   3.  i18n çevirilerini yükle
//   4.  Upload dizinini oluştur
//   5.  Repository'leri oluştur (DB bağlantısı ile)
//   6.  Encryption key derive et (AES-256)
//   7.  Platform LiveKit instance seed et
//   8.  WebSocket Hub'ı başlat
//   9.  Service'leri oluştur (repository'ler + hub ile)
//  10.  Handler'ları oluştur (service'ler ile)
//  11.  Middleware'ları oluştur (service + repo'lar ile)
//  12.  HTTP router'ı kur, route'ları bağla
//  13.  CORS yapılandır
//  14.  HTTP Server'ı başlat
//  15.  Graceful shutdown
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
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/pkg/i18n"
	"github.com/akinalp/mqvi/pkg/ratelimit"
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
	livekitRepo := repository.NewSQLiteLiveKitRepo(db.Conn)

	// ─── 6. Encryption Key ───
	//
	// AES-256-GCM şifreleme anahtarı — LiveKit credential'larını DB'de
	// şifrelenmiş saklamak için. ENCRYPTION_KEY env variable'dan (64 hex char)
	// 32-byte binary key'e dönüştürülür.
	encryptionKey, err := crypto.DeriveKey(cfg.EncryptionKey)
	if err != nil {
		log.Fatalf("[main] invalid ENCRYPTION_KEY: %v", err)
	}

	// ─── 7. Platform LiveKit Instance Seed ───
	//
	// Eğer LIVEKIT_URL + API key/secret env var'larında tanımlıysa ve henüz
	// platform-managed bir LiveKit instance yoksa, veritabanına seed et.
	// Bu, "mqvi hosted" sunucuların kullanacağı platform LiveKit instance'ıdır.
	if cfg.LiveKit.URL != "" && cfg.LiveKit.APIKey != "" && cfg.LiveKit.APISecret != "" {
		platformInstance, seedErr := livekitRepo.GetLeastLoadedPlatformInstance(context.Background())
		if seedErr != nil {
			// Platform instance yok, yeni bir tane oluştur
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
			if createErr := livekitRepo.Create(context.Background(), platformInstance); createErr != nil {
				log.Fatalf("[main] failed to seed platform livekit instance: %v", createErr)
			}
			log.Printf("[main] seeded platform LiveKit instance (url=%s)", cfg.LiveKit.URL)
		}

		// Migration sonrası orphan sunucuları (livekit_instance_id = NULL) platform instance'a bağla.
		// Eski tek-sunucu mimarisinden migrate edilen "default" sunucu buna dahildir.
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

	// ─── 7b. Empty-ID Cleanup ───
	//
	// Önceki bir bug'da servers ve livekit_instances tablolarına boş ID ("") ile
	// kayıt ekleniyordu (ID auto-generation eksikti). Bu kayıtlar fonksiyonel değil
	// çünkü API path'te serverId boş olunca 400 döner. Burada temizliyoruz.
	{
		// 1. Boş ID'li livekit instance varsa, yeni rastgele ID ata
		//    ve bağlı sunucuların referanslarını güncelle
		var emptyLK int
		_ = db.Conn.QueryRowContext(context.Background(),
			`SELECT COUNT(*) FROM livekit_instances WHERE id = ''`).Scan(&emptyLK)
		if emptyLK > 0 {
			// Yeni ID üret
			var newLKID string
			_ = db.Conn.QueryRowContext(context.Background(),
				`SELECT lower(hex(randomblob(8)))`).Scan(&newLKID)
			_, _ = db.Conn.ExecContext(context.Background(),
				`UPDATE livekit_instances SET id = ? WHERE id = ''`, newLKID)
			// Sunucuların referanslarını güncelle
			res, err := db.Conn.ExecContext(context.Background(),
				`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ''`, newLKID)
			if err == nil {
				if aff, _ := res.RowsAffected(); aff > 0 {
					log.Printf("[main] fixed empty-ID livekit instance → %s (%d server refs updated)", newLKID, aff)
				}
			}
		}

		// 2. Boş ID'li sunucuları ve ilişkili verilerini temizle
		//    (ALTER TABLE ile eklenen FK'lar CASCADE yapmaz, manual temizlik gerek)
		var emptySrv int
		_ = db.Conn.QueryRowContext(context.Background(),
			`SELECT COUNT(*) FROM servers WHERE id = ''`).Scan(&emptySrv)
		if emptySrv > 0 {
			db.Conn.ExecContext(context.Background(), `DELETE FROM channels WHERE server_id = ''`)
			db.Conn.ExecContext(context.Background(), `DELETE FROM categories WHERE server_id = ''`)
			db.Conn.ExecContext(context.Background(), `DELETE FROM roles WHERE server_id = ''`)
			db.Conn.ExecContext(context.Background(), `DELETE FROM user_roles WHERE server_id = ''`)
			db.Conn.ExecContext(context.Background(), `DELETE FROM invites WHERE server_id = ''`)
			db.Conn.ExecContext(context.Background(), `DELETE FROM bans WHERE server_id = ''`)
			db.Conn.ExecContext(context.Background(), `DELETE FROM server_members WHERE server_id = ''`)
			db.Conn.ExecContext(context.Background(), `DELETE FROM servers WHERE id = ''`)
			log.Printf("[main] cleaned up %d empty-ID server(s) and related data", emptySrv)
		}
	}

	// ─── 8. WebSocket Hub ───
	//
	// Hub, tüm WebSocket bağlantılarını yöneten merkezi yapıdır.
	// `go hub.Run()` ayrı bir goroutine'de event loop başlatır:
	// register/unregister channel'larını dinler ve client map'ini günceller.
	// Hub aynı zamanda EventPublisher interface'ini implement eder —
	// service'ler hub'a doğrudan bağımlı olmak yerine interface üzerinden erişir.
	hub := ws.NewHub()

	// ChannelPermissionService — VoiceService ve MessageService'den ÖNCE oluşturulmalı,
	// çünkü ikisi de kanal bazlı permission resolution için buna bağımlı.
	//
	// Multi-server: channelGetter (channelRepo) eklendi — ResolveChannelPermissions'da
	// channel → server_id lookup yaparak rolleri sunucu bazlı çeker.
	channelPermService := services.NewChannelPermissionService(channelPermRepo, roleRepo, channelRepo, hub)

	// VoiceService — Hub callback'lerinden önce oluşturulmalı çünkü
	// OnUserFullyDisconnected callback'i voice cleanup için voiceService'e ihtiyaç duyar.
	//
	// Multi-server: livekitGetter (livekitRepo) + encryptionKey ile per-server
	// LiveKit token generation. Static cfg.LiveKit yerine DB'den instance lookup yapılır.
	voiceService := services.NewVoiceService(channelRepo, livekitRepo, channelPermService, hub, encryptionKey)

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
		// Kullanıcının DB'deki tercih edilen status'unu oku.
		// Bu status, kullanıcının en son seçtiği durumu temsil eder
		// ve oturumlar arası korunur (persist).
		user, err := userRepo.GetByID(context.Background(), userID)
		if err != nil {
			log.Printf("[presence] failed to get user %s: %v", userID, err)
			return
		}

		preferredStatus := user.Status

		// Invisible modu: DB'de "offline" = kullanıcı invisible olmak istiyor.
		// Bu durumda:
		// 1. Hub'da invisible olarak işaretle (handler.go'da da yapılıyor,
		//    ama callback race condition'a karşı burada da set ederiz)
		// 2. Diğer kullanıcılara "offline" olarak broadcast et (görünmez kal)
		// 3. DB status'unu DEĞİŞTİRME — tercih korunsun
		if preferredStatus == models.UserStatusOffline {
			hub.SetInvisible(userID, true)
			// Invisible kullanıcı için broadcast YAPMA — zaten "offline" görünüyor.
			// Diğer client'lar ready event'te bu kullanıcıyı görmeyecek.
			log.Printf("[presence] user %s connected as invisible", userID)
			return
		}

		// Normal durum: Tercih edilen status'u broadcast et.
		// "online", "idle" veya "dnd" — kullanıcının seçimi korunur.
		// DB'deki status zaten doğru olduğu için güncelleme gerekmez.
		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(preferredStatus),
			},
		})
		log.Printf("[presence] user %s is now %s (restored preference)", userID, preferredStatus)
	})

	hub.OnUserFullyDisconnected(func(userID string) {
		// Presence: DB status'unu DEĞİŞTİRME — kullanıcının tercih ettiği status
		// (online/idle/dnd/offline) korunmalı. Bir sonraki bağlantıda
		// OnUserFirstConnect bu tercihi okuyup doğru şekilde broadcast edecek.
		//
		// Invisible tracking: kullanıcı koptuğunda invisible set'inden temizle.
		// Zaten bağlı olmadığı için GetVisibleOnlineUserIDs'ta görünmez,
		// ama set'i temiz tutmak için kaldırıyoruz.
		hub.SetInvisible(userID, false)

		// Diğer kullanıcılara "offline" olarak broadcast et.
		// Invisible kullanıcılar zaten "offline" görünüyordu, normal kullanıcılar
		// artık gerçekten offline. Her iki durumda da doğru broadcast.
		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(models.UserStatusOffline),
			},
		})
		log.Printf("[presence] user %s disconnected (preference preserved in DB)", userID)

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

		// Invisible tracking: "offline" seçilirse invisible olarak işaretle,
		// başka bir status seçilirse invisible'dan çıkar.
		hub.SetInvisible(userID, status == string(models.UserStatusOffline))

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
	hub.OnVoiceMoveUser(func(moverUserID, targetUserID, targetChannelID string) {
		if err := voiceService.MoveUser(context.Background(), moverUserID, targetUserID, targetChannelID); err != nil {
			log.Printf("[voice] move user error mover=%s target=%s channel=%s: %v", moverUserID, targetUserID, targetChannelID, err)
		}
	})
	hub.OnVoiceDisconnectUser(func(disconnecterUserID, targetUserID string) {
		if err := voiceService.AdminDisconnectUser(context.Background(), disconnecterUserID, targetUserID); err != nil {
			log.Printf("[voice] disconnect user error disconnecter=%s target=%s: %v", disconnecterUserID, targetUserID, err)
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

	// DM typing callback — DM kanalında typing event'i geldiğinde
	// kanal üyesi lookup + karşı tarafa broadcast
	hub.OnDMTyping(func(senderUserID, senderUsername, dmChannelID string) {
		channel, err := dmRepo.GetChannelByID(context.Background(), dmChannelID)
		if err != nil {
			return
		}
		// Gönderen bu kanalın üyesi mi kontrol et
		if channel.User1ID != senderUserID && channel.User2ID != senderUserID {
			return
		}
		// Karşı tarafı bul
		otherUserID := channel.User1ID
		if otherUserID == senderUserID {
			otherUserID = channel.User2ID
		}
		// Sadece karşı tarafa typing event'i gönder (gönderen hariç)
		hub.BroadcastToUser(otherUserID, ws.Event{
			Op: ws.OpDMTypingStart,
			Data: ws.DMTypingStartData{
				UserID:      senderUserID,
				Username:    senderUsername,
				DMChannelID: dmChannelID,
			},
		})
	})

	go hub.Run()

	// ─── 9. Service Layer ───
	//
	// Multi-server mimaride service constructor'ları güncellendi:
	// - AuthService: invite code ve ban kontrolü kaldırıldı (sunucu bağımsız kayıt)
	// - ServerService: yeni — sunucu oluşturma, katılma, ayrılma, silme
	// - MemberService: serverRepo eklendi (sunucu bazlı üyelik)
	// - VoiceService: per-server LiveKit (livekitGetter + encryptionKey)
	// - ChannelPermService: channelGetter eklendi (channel → server_id lookup)

	inviteService := services.NewInviteService(inviteRepo, serverRepo)

	// AuthService — multi-server'da simplified: sadece userRepo + sessionRepo + hub.
	// Register hiçbir sunucuya üye eklemez, ban kontrolü sunucu bazlı olduğu için kaldırıldı.
	authService := services.NewAuthService(
		userRepo,
		sessionRepo,
		hub,
		cfg.JWT.Secret,
		cfg.JWT.AccessTokenExpiry,
		cfg.JWT.RefreshTokenExpiry,
	)

	channelService := services.NewChannelService(channelRepo, categoryRepo, hub, channelPermService)
	categoryService := services.NewCategoryService(categoryRepo, hub)
	messageService := services.NewMessageService(messageRepo, attachmentRepo, channelRepo, userRepo, mentionRepo, reactionRepo, hub, channelPermService)
	uploadService := services.NewUploadService(attachmentRepo, cfg.Upload.Dir, cfg.Upload.MaxSize)
	memberService := services.NewMemberService(userRepo, roleRepo, banRepo, serverRepo, hub, voiceService)
	roleService := services.NewRoleService(roleRepo, userRepo, hub)

	// ServerService — multi-server'ın kalbi: sunucu CRUD, üyelik, LiveKit instance yönetimi.
	// CreateServer akışı: server → livekit instance → default roller → default kanallar → owner membership.
	serverService := services.NewServerService(
		serverRepo,
		livekitRepo,
		roleRepo,
		channelRepo,
		categoryRepo,
		userRepo,
		inviteService,
		hub,
		encryptionKey,
	)

	pinService := services.NewPinService(pinRepo, messageRepo, hub)
	searchService := services.NewSearchService(searchRepo)
	readStateService := services.NewReadStateService(readStateRepo, channelPermService)
	dmService := services.NewDMService(dmRepo, userRepo, hub)
	dmUploadService := services.NewDMUploadService(dmRepo, cfg.Upload.Dir, cfg.Upload.MaxSize)
	reactionService := services.NewReactionService(reactionRepo, messageRepo, hub)
	friendshipService := services.NewFriendshipService(friendshipRepo, userRepo, hub)
	// voiceService ve channelPermService yukarıda (Hub callback'lerinden önce) oluşturuldu

	// ─── 10. Handler Layer ───

	// Login brute-force koruması: 2 dakikalık pencerede IP başına 5 deneme.
	// 5 başarısız denemeden sonra o IP 2 dakika boyunca bloke olur.
	// Başarılı login sayacı sıfırlar — meşru kullanıcı etkilenmez.
	loginLimiter := ratelimit.NewLoginRateLimiter(5, 2*time.Minute)

	authHandler := handlers.NewAuthHandler(authService, loginLimiter)
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
	dmHandler := handlers.NewDMHandler(dmService, dmUploadService, cfg.Upload.MaxSize)
	reactionHandler := handlers.NewReactionHandler(reactionService)
	channelPermHandler := handlers.NewChannelPermissionHandler(channelPermService)
	friendshipHandler := handlers.NewFriendshipHandler(friendshipService)
	avatarHandler := handlers.NewAvatarHandler(userRepo, memberService, serverService, cfg.Upload.Dir)
	statsHandler := handlers.NewStatsHandler(userRepo)

	// WS Handler — multi-server'da ban kontrolü sunucu bazlı olduğu için
	// BanChecker nil geçilir. WS bağlantısı platforma erişim verir;
	// sunucu erişimi ServerMembershipMiddleware ile korunur.
	// serverRepo: ready event'te sunucu listesi + client.serverIDs doldurma.
	wsHandler := ws.NewHandler(hub, authService, nil, voiceService, userRepo, serverRepo)

	// ─── 11. Middleware ───
	authMw := middleware.NewAuthMiddleware(authService, userRepo)
	permMw := middleware.NewPermissionMiddleware(roleRepo)
	serverMw := middleware.NewServerMembershipMiddleware(serverRepo)

	// ─── Middleware Chain Helpers ───
	//
	// auth: sadece JWT token doğrulaması
	// authServer: auth + sunucu üyelik kontrolü (serverID context'e eklenir)
	// authServerPerm: auth + sunucu üyelik + belirli permission kontrolü
	// authServerPermLoad: auth + sunucu üyelik + permission bilgisi yükleme (kontrol handler'da)
	auth := func(h http.HandlerFunc) http.Handler {
		return authMw.Require(http.HandlerFunc(h))
	}
	authServer := func(h http.HandlerFunc) http.Handler {
		return authMw.Require(serverMw.Require(http.HandlerFunc(h)))
	}
	authServerPerm := func(perm models.Permission, h http.HandlerFunc) http.Handler {
		return authMw.Require(serverMw.Require(permMw.Require(perm, http.HandlerFunc(h))))
	}
	authServerPermLoad := func(h http.HandlerFunc) http.Handler {
		return authMw.Require(serverMw.Require(permMw.Load(http.HandlerFunc(h))))
	}

	// ─── 12. HTTP Router ───
	mux := http.NewServeMux()

	// ╔══════════════════════════════════════════╗
	// ║  GLOBAL ROUTES (sunucu bağımsız)         ║
	// ╚══════════════════════════════════════════╝

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
	mux.Handle("POST /api/auth/logout", auth(authHandler.Logout))

	// User — kendi profili, şifre, email, avatar
	mux.Handle("GET /api/users/me", auth(authHandler.Me))
	mux.Handle("PATCH /api/users/me/profile", auth(memberHandler.UpdateProfile))
	mux.Handle("POST /api/users/me/password", auth(authHandler.ChangePassword))
	mux.Handle("PUT /api/users/me/email", auth(authHandler.ChangeEmail))
	mux.Handle("POST /api/users/me/avatar", auth(avatarHandler.UploadUserAvatar))

	// Servers — sunucu listesi, oluşturma, katılma (sunucu üyeliği gerekmez)
	mux.Handle("GET /api/servers", auth(serverHandler.ListMyServers))
	mux.Handle("POST /api/servers", auth(serverHandler.CreateServer))
	// "join" literal path'i {serverId} parametresinden ÖNCE tanımlanmalı —
	// yoksa Go router "join" kelimesini bir {serverId} olarak yorumlar.
	mux.Handle("POST /api/servers/join", auth(serverHandler.JoinServer))

	// Upload — bağımsız dosya yükleme endpoint'i (sunucu bağımsız)
	mux.Handle("POST /api/upload", auth(messageHandler.Upload))

	// DMs — Direct Messages, sunucu bağımsız özel mesajlaşma
	mux.Handle("GET /api/dms", auth(dmHandler.ListChannels))
	mux.Handle("POST /api/dms", auth(dmHandler.CreateOrGetChannel))
	mux.Handle("GET /api/dms/{channelId}/messages", auth(dmHandler.GetMessages))
	mux.Handle("POST /api/dms/{channelId}/messages", auth(dmHandler.SendMessage))
	mux.Handle("PATCH /api/dms/messages/{id}", auth(dmHandler.EditMessage))
	mux.Handle("DELETE /api/dms/messages/{id}", auth(dmHandler.DeleteMessage))
	mux.Handle("POST /api/dms/messages/{id}/reactions", auth(dmHandler.ToggleReaction))
	mux.Handle("POST /api/dms/messages/{id}/pin", auth(dmHandler.PinMessage))
	mux.Handle("DELETE /api/dms/messages/{id}/pin", auth(dmHandler.UnpinMessage))
	mux.Handle("GET /api/dms/{channelId}/pinned", auth(dmHandler.GetPinnedMessages))
	mux.Handle("GET /api/dms/{channelId}/search", auth(dmHandler.SearchMessages))

	// Friends — arkadaşlık yönetimi, sunucu bağımsız
	// "requests" literal path'i {userId} parametresinden ÖNCE tanımlanmalı —
	// yoksa Go router "requests" kelimesini bir {userId} olarak yorumlar.
	mux.Handle("GET /api/friends/requests", auth(friendshipHandler.ListRequests))
	mux.Handle("POST /api/friends/requests", auth(friendshipHandler.SendRequest))
	mux.Handle("POST /api/friends/requests/{id}/accept", auth(friendshipHandler.AcceptRequest))
	mux.Handle("DELETE /api/friends/requests/{id}", auth(friendshipHandler.DeclineRequest))
	mux.Handle("GET /api/friends", auth(friendshipHandler.ListFriends))
	mux.Handle("DELETE /api/friends/{userId}", auth(friendshipHandler.RemoveFriend))

	// ╔══════════════════════════════════════════╗
	// ║  SERVER-SCOPED ROUTES                     ║
	// ║  auth + ServerMembership middleware       ║
	// ╚══════════════════════════════════════════╝

	// Server — detay, güncelleme, silme, ayrılma, ikon
	mux.Handle("GET /api/servers/{serverId}", authServer(serverHandler.GetServer))
	mux.Handle("PATCH /api/servers/{serverId}", authServerPerm(models.PermAdmin, serverHandler.UpdateServer))
	mux.Handle("DELETE /api/servers/{serverId}", authServer(serverHandler.DeleteServer))
	mux.Handle("POST /api/servers/{serverId}/leave", authServer(serverHandler.LeaveServer))
	mux.Handle("POST /api/servers/{serverId}/icon", authServerPerm(models.PermAdmin, avatarHandler.UploadServerIcon))

	// LiveKit — sunucunun LiveKit ayarları (URL + tip bilgisi, secret yok)
	mux.Handle("GET /api/servers/{serverId}/livekit", authServerPerm(models.PermAdmin, serverHandler.GetLiveKitSettings))

	// Channels — sunucu bazlı kanal yönetimi
	mux.Handle("GET /api/servers/{serverId}/channels", authServer(channelHandler.List))
	mux.Handle("POST /api/servers/{serverId}/channels", authServerPerm(models.PermManageChannels, channelHandler.Create))
	// Reorder route'u {id} parametreli route'lardan ÖNCE tanımlanmalı —
	// yoksa Go router "reorder" kelimesini bir {id} olarak yorumlar.
	mux.Handle("PATCH /api/servers/{serverId}/channels/reorder", authServerPerm(models.PermManageChannels, channelHandler.Reorder))
	mux.Handle("PATCH /api/servers/{serverId}/channels/{id}", authServerPerm(models.PermManageChannels, channelHandler.Update))
	mux.Handle("DELETE /api/servers/{serverId}/channels/{id}", authServerPerm(models.PermManageChannels, channelHandler.Delete))

	// Categories — sunucu bazlı kategori yönetimi
	mux.Handle("GET /api/servers/{serverId}/categories", authServer(categoryHandler.List))
	mux.Handle("POST /api/servers/{serverId}/categories", authServerPerm(models.PermManageChannels, categoryHandler.Create))
	mux.Handle("PATCH /api/servers/{serverId}/categories/{id}", authServerPerm(models.PermManageChannels, categoryHandler.Update))
	mux.Handle("DELETE /api/servers/{serverId}/categories/{id}", authServerPerm(models.PermManageChannels, categoryHandler.Delete))

	// Messages — sunucu bazlı mesaj CRUD
	mux.Handle("GET /api/servers/{serverId}/channels/{id}/messages", authServer(messageHandler.List))
	mux.Handle("POST /api/servers/{serverId}/channels/{id}/messages", authServer(messageHandler.Create))
	mux.Handle("PATCH /api/servers/{serverId}/messages/{id}", authServer(messageHandler.Update))
	mux.Handle("DELETE /api/servers/{serverId}/messages/{id}", authServerPermLoad(messageHandler.Delete))

	// Reactions — sunucu bazlı emoji tepkileri
	mux.Handle("POST /api/servers/{serverId}/messages/{messageId}/reactions", authServer(reactionHandler.Toggle))

	// Pins — sunucu bazlı mesaj sabitleme
	mux.Handle("GET /api/servers/{serverId}/channels/{id}/pins", authServer(pinHandler.ListPins))
	mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/messages/{messageId}/pin", authServerPerm(models.PermManageMessages, pinHandler.Pin))
	mux.Handle("DELETE /api/servers/{serverId}/channels/{channelId}/messages/{messageId}/pin", authServerPerm(models.PermManageMessages, pinHandler.Unpin))

	// Read State — sunucu bazlı okunmamış mesaj takibi
	mux.Handle("POST /api/servers/{serverId}/channels/{id}/read", authServer(readStateHandler.MarkRead))
	mux.Handle("GET /api/servers/{serverId}/channels/unread", authServer(readStateHandler.GetUnreads))

	// Members — sunucu bazlı üye yönetimi
	mux.Handle("GET /api/servers/{serverId}/members", authServer(memberHandler.List))
	mux.Handle("GET /api/servers/{serverId}/members/{id}", authServer(memberHandler.Get))
	mux.Handle("PATCH /api/servers/{serverId}/members/{id}/roles", authServerPerm(models.PermManageRoles, memberHandler.ModifyRoles))
	mux.Handle("DELETE /api/servers/{serverId}/members/{id}", authServerPerm(models.PermKickMembers, memberHandler.Kick))
	mux.Handle("POST /api/servers/{serverId}/members/{id}/ban", authServerPerm(models.PermBanMembers, memberHandler.Ban))

	// Bans — sunucu bazlı ban yönetimi
	mux.Handle("GET /api/servers/{serverId}/bans", authServerPerm(models.PermBanMembers, memberHandler.GetBans))
	mux.Handle("DELETE /api/servers/{serverId}/bans/{id}", authServerPerm(models.PermBanMembers, memberHandler.Unban))

	// Roles — sunucu bazlı rol yönetimi
	mux.Handle("GET /api/servers/{serverId}/roles", authServer(roleHandler.List))
	mux.Handle("POST /api/servers/{serverId}/roles", authServerPerm(models.PermManageRoles, roleHandler.Create))
	// Reorder route'u {id} parametreli route'lardan ÖNCE tanımlanmalı
	mux.Handle("PATCH /api/servers/{serverId}/roles/reorder", authServerPerm(models.PermManageRoles, roleHandler.Reorder))
	mux.Handle("PATCH /api/servers/{serverId}/roles/{id}", authServerPerm(models.PermManageRoles, roleHandler.Update))
	mux.Handle("DELETE /api/servers/{serverId}/roles/{id}", authServerPerm(models.PermManageRoles, roleHandler.Delete))

	// Channel Permissions — sunucu bazlı kanal permission override
	mux.Handle("GET /api/servers/{serverId}/channels/{id}/permissions", authServer(channelPermHandler.ListOverrides))
	mux.Handle("PUT /api/servers/{serverId}/channels/{channelId}/permissions/{roleId}", authServerPerm(models.PermManageChannels, channelPermHandler.SetOverride))
	mux.Handle("DELETE /api/servers/{serverId}/channels/{channelId}/permissions/{roleId}", authServerPerm(models.PermManageChannels, channelPermHandler.DeleteOverride))

	// Invites — sunucu bazlı davet kodu yönetimi
	mux.Handle("GET /api/servers/{serverId}/invites", authServerPerm(models.PermManageInvites, inviteHandler.List))
	mux.Handle("POST /api/servers/{serverId}/invites", authServerPerm(models.PermManageInvites, inviteHandler.Create))
	mux.Handle("DELETE /api/servers/{serverId}/invites/{code}", authServerPerm(models.PermManageInvites, inviteHandler.Delete))

	// Search — sunucu bazlı FTS5 tam metin arama
	mux.Handle("GET /api/servers/{serverId}/search", authServer(searchHandler.Search))

	// Voice — sunucu bazlı ses kanalı token ve durumlar
	//
	// Token endpoint, kullanıcının voice kanala bağlanmak için ihtiyaç duyduğu
	// LiveKit JWT'sini döner. Permission kontrolü service katmanında yapılır
	// (PermConnectVoice, PermSpeak, PermStream ayrı ayrı kontrol edilip
	// LiveKit token grant'larına yansıtılır).
	// Per-server: token, sunucuya bağlı LiveKit instance üzerinden üretilir.
	mux.Handle("POST /api/servers/{serverId}/voice/token", authServer(voiceHandler.Token))
	mux.Handle("GET /api/servers/{serverId}/voice/states", authServer(voiceHandler.VoiceStates))

	// ╔══════════════════════════════════════════╗
	// ║  STATIC FILES & WEBSOCKET                ║
	// ╚══════════════════════════════════════════╝

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

	// ─── 13. SPA Frontend Serving ───
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

	// ─── 14. CORS ───
	//
	// CORS_ORIGINS env variable ile ek origin'ler eklenebilir (virgülle ayrılmış).
	// Production'da frontend aynı origin'den servis edilir — CORS gerekmez.
	// Ama Tauri desktop client ve development için CORS hâlâ gerekli.
	corsOrigins := []string{
		"http://localhost:3030",    // Vite dev server
		"http://localhost:1420",    // Tauri dev
		"tauri://localhost",        // Tauri production (macOS/Linux)
		"https://tauri.localhost",  // Tauri production (Windows, release)
		"http://tauri.localhost",   // Tauri production (Windows, debug)
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
	corsHandler := cors.New(cors.Options{
		AllowedOrigins:   corsOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	})

	// ─── 15. Final Handler ───
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

	// ─── 16. HTTP Server ───
	srv := &http.Server{
		Addr:         cfg.Server.Addr(),
		Handler:      finalHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// ─── 17. Graceful Shutdown ───
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
