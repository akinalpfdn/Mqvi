// Package services — ServerService: çoklu sunucu yönetimi iş mantığı.
//
// Sunucu oluşturma, katılma, ayrılma, güncelleme, silme.
// Her sunucu kendi LiveKit instance'ına bağlı olabilir (mqvi hosted veya self-hosted).
// Sunucu oluşturulurken default roller, kategoriler ve kanallar otomatik oluşturulur.
package services

import (
	"context"
	"database/sql"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// LiveKitSettings, sunucu ayarlarında göstermek için LiveKit bilgileri.
// Secret'lar asla client'a gönderilmez — sadece URL ve tip bilgisi.
type LiveKitSettings struct {
	URL               string `json:"url"`
	IsPlatformManaged bool   `json:"is_platform_managed"`
}

// ServerService, çoklu sunucu yönetimi iş mantığı interface'i.
type ServerService interface {
	// CreateServer, yeni bir sunucu oluşturur.
	// Akış: server → livekit instance → default roller → default kanallar → owner membership.
	CreateServer(ctx context.Context, ownerID string, req *models.CreateServerRequest) (*models.Server, error)

	// GetServer, sunucu detayını döner.
	GetServer(ctx context.Context, serverID string) (*models.Server, error)

	// GetUserServers, kullanıcının üye olduğu sunucuların listesini döner.
	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)

	// UpdateServer, sunucu bilgisini günceller (isim, invite_required, livekit credentials).
	UpdateServer(ctx context.Context, serverID string, req *models.UpdateServerRequest) (*models.Server, error)

	// UpdateIcon, sunucu ikonunu günceller.
	UpdateIcon(ctx context.Context, serverID, iconURL string) (*models.Server, error)

	// DeleteServer, sunucuyu siler. Sadece owner yapabilir.
	DeleteServer(ctx context.Context, serverID, userID string) error

	// JoinServer, davet koduyla sunucuya katılır.
	JoinServer(ctx context.Context, userID, inviteCode string) (*models.Server, error)

	// LeaveServer, sunucudan ayrılır. Owner ayrılamaz.
	LeaveServer(ctx context.Context, serverID, userID string) error

	// GetLiveKitSettings, sunucunun LiveKit ayarlarını döner (URL + tip).
	// Secret'lar dahil edilmez — sadece owner'ın ayarlar sayfasında görmesi için.
	GetLiveKitSettings(ctx context.Context, serverID string) (*LiveKitSettings, error)

	// ReorderServers, kullanıcının sunucu listesini sıralar.
	// Per-user: sadece o kullanıcının sıralaması değişir, başkalarını etkilemez.
	// WS broadcast YAPILMAZ — kişisel sıralama.
	ReorderServers(ctx context.Context, userID string, req *models.ReorderServersRequest) ([]models.ServerListItem, error)
}

type serverService struct {
	db            *sql.DB // Transaction desteği (WithTx) için — CreateServer atomik çalışır
	serverRepo    repository.ServerRepository
	livekitRepo   repository.LiveKitRepository
	roleRepo      repository.RoleRepository
	channelRepo   repository.ChannelRepository
	categoryRepo  repository.CategoryRepository
	userRepo      repository.UserRepository
	inviteService InviteService
	hub           ws.BroadcastAndManage
	encryptionKey []byte
}

// NewServerService, constructor.
//
// db: CreateServer'da WithTx ile atomik işlem için doğrudan *sql.DB gerekir.
// Repository'ler normal operasyonlarda kullanılır, transaction içinde tx-bound
// repo'lar oluşturulur.
//
// encryptionKey: LiveKit credential'larını AES-256-GCM ile şifrelemek için kullanılır.
// inviteService: JoinServer'da davet kodunu doğrulamak için.
func NewServerService(
	db *sql.DB,
	serverRepo repository.ServerRepository,
	livekitRepo repository.LiveKitRepository,
	roleRepo repository.RoleRepository,
	channelRepo repository.ChannelRepository,
	categoryRepo repository.CategoryRepository,
	userRepo repository.UserRepository,
	inviteService InviteService,
	hub ws.BroadcastAndManage,
	encryptionKey []byte,
) ServerService {
	return &serverService{
		db:            db,
		serverRepo:    serverRepo,
		livekitRepo:   livekitRepo,
		roleRepo:      roleRepo,
		channelRepo:   channelRepo,
		categoryRepo:  categoryRepo,
		userRepo:      userRepo,
		inviteService: inviteService,
		hub:           hub,
		encryptionKey: encryptionKey,
	}
}

// CreateServer, yeni bir sunucu oluşturur.
//
// Akış:
// 1. Validate request
// 2. host_type'a göre LiveKit instance oluştur veya platform instance bağla
// 3-8. Transaction: Server INSERT → üyelik → roller → kanallar (atomik)
// 9. WS broadcast (transaction dışında — DB'ye yazıldıktan sonra)
//
// Transaction neden gerekli?
// Adım 3-8'de 9 ayrı INSERT yapılır. Herhangi biri başarısız olursa
// (örneğin rol oluşturma hatası), önceki adımlar DB'de kalır — "sahipsiz"
// sunucu, rolsüz üye gibi tutarsız veri oluşur.
// WithTx ile hepsi tek birim: ya hepsi yazılır (COMMIT) ya hiçbiri (ROLLBACK).
func (s *serverService) CreateServer(ctx context.Context, ownerID string, req *models.CreateServerRequest) (*models.Server, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// ─── mqvi-hosted sunucu limiti ───
	// Normal kullanıcılar max 1 mqvi-hosted sunucu oluşturabilir (owner olarak).
	// Platform admin sınırsız. Self-hosted sınırsız.
	if req.HostType == "mqvi_hosted" {
		user, err := s.userRepo.GetByID(ctx, ownerID)
		if err != nil {
			return nil, fmt.Errorf("failed to get user: %w", err)
		}
		if !user.IsPlatformAdmin {
			count, err := s.serverRepo.CountOwnedMqviHostedServers(ctx, ownerID)
			if err != nil {
				return nil, fmt.Errorf("failed to count owned servers: %w", err)
			}
			if count >= 1 {
				return nil, fmt.Errorf("%w: you can only own 1 mqvi-hosted server, you can create unlimited self-hosted servers", pkg.ErrBadRequest)
			}
		}
	}

	// ─── LiveKit Instance (transaction dışında) ───
	// LiveKit operasyonları bağımsız — kendi tablosunda çalışır.
	// Hata olursa sunucu oluşturulmadan dönülür.
	var livekitInstanceID *string

	switch req.HostType {
	case "self_hosted":
		// Self-hosted: kullanıcının LiveKit credential'larını şifrele ve kaydet
		if req.LiveKitURL == "" || req.LiveKitKey == "" || req.LiveKitSecret == "" {
			return nil, fmt.Errorf("%w: livekit_url, livekit_key, and livekit_secret are required for self-hosted", pkg.ErrBadRequest)
		}

		encKey, err := crypto.Encrypt(req.LiveKitKey, s.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt livekit key: %w", err)
		}
		encSecret, err := crypto.Encrypt(req.LiveKitSecret, s.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt livekit secret: %w", err)
		}

		instance := &models.LiveKitInstance{
			URL:               req.LiveKitURL,
			APIKey:            encKey,
			APISecret:         encSecret,
			IsPlatformManaged: false,
			ServerCount:       1,
		}

		if err := s.livekitRepo.Create(ctx, instance); err != nil {
			return nil, fmt.Errorf("failed to create livekit instance: %w", err)
		}

		livekitInstanceID = &instance.ID

	case "mqvi_hosted":
		// mqvi hosted: platform'un en az yüklü LiveKit instance'ını bul
		instance, err := s.livekitRepo.GetLeastLoadedPlatformInstance(ctx)
		if err != nil {
			// Platform instance yoksa voice'suz sunucu oluştur
			log.Printf("[server] no platform livekit instance available, creating server without voice: %v", err)
		} else {
			livekitInstanceID = &instance.ID
			if err := s.livekitRepo.IncrementServerCount(ctx, instance.ID); err != nil {
				return nil, fmt.Errorf("failed to increment server count: %w", err)
			}
		}

	default:
		// host_type verilmemişse voice'suz sunucu oluştur
	}

	// ─── Atomik transaction: Server + Üyelik + Roller + Kanallar ───
	//
	// WithTx, tek bir *sql.Tx açar. Bu tx'i repository constructor'larına
	// geçirerek tüm INSERT'ler aynı transaction'da çalışır.
	// Herhangi bir adım hata verirse ROLLBACK — DB'de hiçbir iz kalmaz.
	server := &models.Server{
		Name:              req.Name,
		OwnerID:           ownerID,
		InviteRequired:    false,
		LiveKitInstanceID: livekitInstanceID,
	}

	err := database.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		// Transaction-bound repository'ler — aynı tx üzerinden çalışır
		txServerRepo := repository.NewSQLiteServerRepo(tx)
		txRoleRepo := repository.NewSQLiteRoleRepo(tx)
		txChannelRepo := repository.NewSQLiteChannelRepo(tx)
		txCategoryRepo := repository.NewSQLiteCategoryRepo(tx)

		// 3. Server INSERT
		if err := txServerRepo.Create(ctx, server); err != nil {
			return fmt.Errorf("failed to create server: %w", err)
		}

		// 4. Owner üyeliği
		if err := txServerRepo.AddMember(ctx, server.ID, ownerID); err != nil {
			return fmt.Errorf("failed to add owner as member: %w", err)
		}

		// 5. Default "@everyone" rolü — position=1, temel yetkiler
		defaultPerms := models.PermViewChannel | models.PermReadMessages | models.PermSendMessages |
			models.PermConnectVoice | models.PermSpeak

		defaultRole := &models.Role{
			ServerID:    server.ID,
			Name:        "Member",
			Color:       "#99AAB5",
			Position:    1,
			Permissions: defaultPerms,
			IsDefault:   true,
		}
		if err := txRoleRepo.Create(ctx, defaultRole); err != nil {
			return fmt.Errorf("failed to create default role: %w", err)
		}

		// 6. Owner rolü — en yüksek position, tüm yetkiler
		ownerRole := &models.Role{
			ServerID:    server.ID,
			Name:        "Owner",
			Color:       "#E74C3C",
			Position:    100,
			Permissions: models.PermAll,
		}
		if err := txRoleRepo.Create(ctx, ownerRole); err != nil {
			return fmt.Errorf("failed to create owner role: %w", err)
		}

		// 7. Rol atamaları
		if err := txRoleRepo.AssignToUser(ctx, ownerID, defaultRole.ID, server.ID); err != nil {
			return fmt.Errorf("failed to assign default role to owner: %w", err)
		}
		if err := txRoleRepo.AssignToUser(ctx, ownerID, ownerRole.ID, server.ID); err != nil {
			return fmt.Errorf("failed to assign owner role: %w", err)
		}

		// 8. Default kategoriler + kanallar
		// Discord benzeri yapı: "Text Channels" ve "Voice Channels" ayrı kategoriler.
		textCategory := &models.Category{
			ServerID: server.ID,
			Name:     "Text Channels",
			Position: 0,
		}
		if err := txCategoryRepo.Create(ctx, textCategory); err != nil {
			return fmt.Errorf("failed to create text category: %w", err)
		}

		voiceCategory := &models.Category{
			ServerID: server.ID,
			Name:     "Voice Channels",
			Position: 1,
		}
		if err := txCategoryRepo.Create(ctx, voiceCategory); err != nil {
			return fmt.Errorf("failed to create voice category: %w", err)
		}

		textChannel := &models.Channel{
			ServerID:   server.ID,
			Name:       "general",
			Type:       models.ChannelTypeText,
			CategoryID: &textCategory.ID,
			Position:   0,
		}
		if err := txChannelRepo.Create(ctx, textChannel); err != nil {
			return fmt.Errorf("failed to create default text channel: %w", err)
		}

		voiceChannel := &models.Channel{
			ServerID:   server.ID,
			Name:       "General",
			Type:       models.ChannelTypeVoice,
			CategoryID: &voiceCategory.ID,
			Position:   0,
			Bitrate:    64000,
		}
		if err := txChannelRepo.Create(ctx, voiceChannel); err != nil {
			return fmt.Errorf("failed to create default voice channel: %w", err)
		}

		return nil // → COMMIT
	})

	if err != nil {
		return nil, fmt.Errorf("failed to create server (transaction): %w", err)
	}

	// ─── WS broadcast (transaction dışında — DB'ye yazıldıktan sonra) ───
	s.hub.AddClientServerID(ownerID, server.ID)
	s.hub.BroadcastToUser(ownerID, ws.Event{
		Op: ws.OpServerCreate,
		Data: models.ServerListItem{
			ID:      server.ID,
			Name:    server.Name,
			IconURL: server.IconURL,
		},
	})

	log.Printf("[server] created server %s (name=%s, owner=%s, host=%s)",
		server.ID, server.Name, ownerID, req.HostType)

	return server, nil
}

func (s *serverService) GetServer(ctx context.Context, serverID string) (*models.Server, error) {
	return s.serverRepo.GetByID(ctx, serverID)
}

func (s *serverService) GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error) {
	return s.serverRepo.GetUserServers(ctx, userID)
}

func (s *serverService) UpdateServer(ctx context.Context, serverID string, req *models.UpdateServerRequest) (*models.Server, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}

	// Partial update — sunucu genel bilgileri
	if req.Name != nil {
		server.Name = *req.Name
	}
	if req.InviteRequired != nil {
		server.InviteRequired = *req.InviteRequired
	}

	if err := s.serverRepo.Update(ctx, server); err != nil {
		return nil, fmt.Errorf("failed to update server: %w", err)
	}

	// ─── LiveKit credential güncelleme ───
	// Sadece self-hosted sunucularda kullanılır.
	// 3 alanın tamamı zorunlu (Validate zaten kontrol ediyor).
	if req.HasLiveKitUpdate() {
		if server.LiveKitInstanceID == nil {
			return nil, fmt.Errorf("%w: this server has no LiveKit instance", pkg.ErrBadRequest)
		}

		// Mevcut instance'ı kontrol et — platform-managed değiştirilemez
		instance, err := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
		if err != nil {
			return nil, fmt.Errorf("failed to get livekit instance: %w", err)
		}
		if instance.IsPlatformManaged {
			return nil, fmt.Errorf("%w: cannot modify platform-managed LiveKit instance", pkg.ErrForbidden)
		}

		// Yeni credential'ları şifrele
		encKey, err := crypto.Encrypt(*req.LiveKitKey, s.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt livekit key: %w", err)
		}
		encSecret, err := crypto.Encrypt(*req.LiveKitSecret, s.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt livekit secret: %w", err)
		}

		instance.URL = *req.LiveKitURL
		instance.APIKey = encKey
		instance.APISecret = encSecret

		if err := s.livekitRepo.Update(ctx, instance); err != nil {
			return nil, fmt.Errorf("failed to update livekit instance: %w", err)
		}

		log.Printf("[server] livekit credentials updated for server %s", serverID)
	}

	// Sunucu üyelerine broadcast
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerUpdate,
		Data: server,
	})

	return server, nil
}

func (s *serverService) UpdateIcon(ctx context.Context, serverID, iconURL string) (*models.Server, error) {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}

	server.IconURL = &iconURL

	if err := s.serverRepo.Update(ctx, server); err != nil {
		return nil, fmt.Errorf("failed to update server icon: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerUpdate,
		Data: server,
	})

	return server, nil
}

func (s *serverService) DeleteServer(ctx context.Context, serverID, userID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	// Sadece owner silebilir
	if server.OwnerID != userID {
		return fmt.Errorf("%w: only the server owner can delete the server", pkg.ErrForbidden)
	}

	// LiveKit instance cleanup (self-hosted → sil, platform → decrement)
	if server.LiveKitInstanceID != nil {
		instance, err := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
		if err == nil {
			if instance.IsPlatformManaged {
				if decErr := s.livekitRepo.DecrementServerCount(ctx, instance.ID); decErr != nil {
					log.Printf("[server] failed to decrement livekit server count instance=%s: %v", instance.ID, decErr)
				}
			} else {
				if delErr := s.livekitRepo.Delete(ctx, instance.ID); delErr != nil {
					log.Printf("[server] failed to delete self-hosted livekit instance=%s: %v", instance.ID, delErr)
				}
			}
		}
	}

	// Tüm üyelere sunucu silindi bildirimi — ÖNCE broadcast et, sonra sil
	// (sildikten sonra server_members kaybolur, BroadcastToServer çalışmaz)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	if err := s.serverRepo.Delete(ctx, serverID); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}

	log.Printf("[server] deleted server %s by user %s", serverID, userID)
	return nil
}

// JoinServer, davet koduyla sunucuya katılır.
//
// Akış:
// 1. Davet kodunu doğrula ve kullan (ValidateAndUse)
// 2. Invite'tan server_id al
// 3. Zaten üye mi kontrol et
// 4. Üyelik ekle
// 5. Default rolü ata
// 6. WS broadcast (user'a server listesi + server'a member_join)
func (s *serverService) JoinServer(ctx context.Context, userID, inviteCode string) (*models.Server, error) {
	// 1. Davet kodunu doğrula — invite'ı döner (server_id dahil)
	invite, err := s.inviteService.ValidateAndUse(ctx, inviteCode)
	if err != nil {
		return nil, err
	}

	serverID := invite.ServerID

	// 2. Zaten üye mi?
	isMember, err := s.serverRepo.IsMember(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check membership: %w", err)
	}
	if isMember {
		return nil, fmt.Errorf("%w: already a member of this server", pkg.ErrBadRequest)
	}

	// 3. Üyelik ekle
	if err := s.serverRepo.AddMember(ctx, serverID, userID); err != nil {
		return nil, fmt.Errorf("failed to add member: %w", err)
	}

	// 4. Default rolü ata
	defaultRole, err := s.roleRepo.GetDefaultByServer(ctx, serverID)
	if err != nil {
		log.Printf("[server] failed to get default role for server %s: %v", serverID, err)
	} else {
		if err := s.roleRepo.AssignToUser(ctx, userID, defaultRole.ID, serverID); err != nil {
			log.Printf("[server] failed to assign default role: %v", err)
		}
	}

	// 5. Server bilgisini al
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get server: %w", err)
	}

	// 6. WS client serverIDs güncelle — artık bu sunucunun broadcast'lerini alacak
	s.hub.AddClientServerID(userID, serverID)

	// 7. WS broadcast — kullanıcıya sunucu eklendi
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpServerCreate,
		Data: models.ServerListItem{
			ID:      server.ID,
			Name:    server.Name,
			IconURL: server.IconURL,
		},
	})

	// Sunucu üyelerine yeni üye katıldı bildirimi — tam MemberWithRoles gönder
	// Frontend handleMemberJoin bu veriyi doğrudan member listesine ekler,
	// eksik field olursa sort sırasında localeCompare crash'i olur.
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		log.Printf("[server] failed to get user %s for member_join broadcast: %v", userID, err)
	} else {
		roles, _ := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
		member := models.ToMemberWithRoles(user, roles)
		s.hub.BroadcastToServer(serverID, ws.Event{
			Op:   ws.OpMemberJoin,
			Data: member,
		})
	}

	log.Printf("[server] user %s joined server %s via invite", userID, serverID)
	return server, nil
}

func (s *serverService) LeaveServer(ctx context.Context, serverID, userID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	// Owner ayrılamaz — önce sahipliği devretmeli
	if server.OwnerID == userID {
		return fmt.Errorf("%w: server owner cannot leave; transfer ownership first", pkg.ErrForbidden)
	}

	if err := s.serverRepo.RemoveMember(ctx, serverID, userID); err != nil {
		return fmt.Errorf("failed to remove member: %w", err)
	}

	// WS broadcast — sunucu üyelerine üye ayrıldı bildirimi (ÖNCE broadcast, sonra kaldır)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpMemberLeave,
		Data: map[string]string{
			"server_id": serverID,
			"user_id":   userID,
		},
	})

	// Kullanıcıya sunucu listesinden kaldırıldı bildirimi
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	// WS client serverIDs güncelle — artık bu sunucunun broadcast'lerini almayacak
	s.hub.RemoveClientServerID(userID, serverID)

	log.Printf("[server] user %s left server %s", userID, serverID)
	return nil
}

// GetLiveKitSettings, sunucuya bağlı LiveKit instance'ın URL ve tip bilgisini döner.
// Secret'lar dahil edilmez — sadece ayarlar sayfasında göstermek için.
func (s *serverService) GetLiveKitSettings(ctx context.Context, serverID string) (*LiveKitSettings, error) {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}

	if server.LiveKitInstanceID == nil {
		return nil, fmt.Errorf("%w: this server has no LiveKit instance", pkg.ErrNotFound)
	}

	instance, err := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance: %w", err)
	}

	return &LiveKitSettings{
		URL:               instance.URL,
		IsPlatformManaged: instance.IsPlatformManaged,
	}, nil
}

// ReorderServers, kullanıcının sunucu listesi sıralamasını günceller.
//
// Per-user sıralama: server_members.position alanı sadece o kullanıcının
// kendi görünümünü etkiler. Başka kullanıcıların sıralaması değişmez.
// Bu yüzden WS broadcast YAPILMAZ — Discord da aynı şekilde çalışır.
//
// İstek body'sinde items array'i vardır: her item bir server_id + yeni position.
// Validate edildikten sonra transaction içinde güncellenir.
func (s *serverService) ReorderServers(ctx context.Context, userID string, req *models.ReorderServersRequest) ([]models.ServerListItem, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if err := s.serverRepo.UpdateMemberPositions(ctx, userID, req.Items); err != nil {
		return nil, fmt.Errorf("failed to update server positions: %w", err)
	}

	// Güncel sıralı listeyi döndür
	servers, err := s.serverRepo.GetUserServers(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload servers after reorder: %w", err)
	}

	return servers, nil
}
