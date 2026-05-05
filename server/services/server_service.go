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

// LiveKitSettings exposes non-secret LiveKit info for the settings UI.
type LiveKitSettings struct {
	URL               string `json:"url"`
	IsPlatformManaged bool   `json:"is_platform_managed"`
}

type ServerService interface {
	CreateServer(ctx context.Context, ownerID string, req *models.CreateServerRequest) (*models.Server, error)
	GetServer(ctx context.Context, serverID string) (*models.Server, error)
	// GetServerRaw returns the server without signing file URLs. Used for internal
	// operations like file deletion where the raw DB path is needed.
	GetServerRaw(ctx context.Context, serverID string) (*models.Server, error)
	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)
	UpdateServer(ctx context.Context, serverID string, req *models.UpdateServerRequest) (*models.Server, error)
	UpdateIcon(ctx context.Context, serverID, iconURL string) (*models.Server, error)
	DeleteServer(ctx context.Context, serverID, userID string) error
	JoinServer(ctx context.Context, userID, inviteCode string) (*models.Server, error)
	LeaveServer(ctx context.Context, serverID, userID string) error
	GetLiveKitSettings(ctx context.Context, serverID string) (*LiveKitSettings, error)
	// ReorderServers updates the user's personal server list order. No WS broadcast.
	ReorderServers(ctx context.Context, userID string, req *models.ReorderServersRequest) ([]models.ServerListItem, error)
}

type serverService struct {
	db            *sql.DB // for WithTx in CreateServer
	serverRepo    repository.ServerRepository
	livekitRepo   repository.LiveKitRepository
	roleRepo      repository.RoleRepository
	channelRepo   repository.ChannelRepository
	categoryRepo  repository.CategoryRepository
	userRepo      repository.UserRepository
	inviteService InviteService
	hub           ws.BroadcastAndManage
	encryptionKey []byte // AES-256-GCM for LiveKit credentials
	urlSigner     FileURLSigner
}

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
	urlSigner FileURLSigner,
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
		urlSigner:     urlSigner,
	}
}

// CreateServer creates a new server atomically (server + membership + roles + channels in one tx).
func (s *serverService) CreateServer(ctx context.Context, ownerID string, req *models.CreateServerRequest) (*models.Server, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Non-admin users can own at most 1 mqvi-hosted server
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

	// ─── LiveKit instance setup (outside transaction) ───
	var livekitInstanceID *string

	switch req.HostType {
	case "self_hosted":
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
		instance, err := s.livekitRepo.GetLeastLoadedPlatformInstance(ctx)
		if err != nil {
			log.Printf("[server] no platform livekit instance available, creating server without voice: %v", err)
		} else {
			livekitInstanceID = &instance.ID
			if err := s.livekitRepo.IncrementServerCount(ctx, instance.ID); err != nil {
				return nil, fmt.Errorf("failed to increment server count: %w", err)
			}
		}

	default:
		// No voice support
	}

	// ─── Atomic transaction: server + membership + roles + channels ───
	server := &models.Server{
		Name:              req.Name,
		OwnerID:           ownerID,
		InviteRequired:    false,
		LiveKitInstanceID: livekitInstanceID,
	}

	err := database.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		txServerRepo := repository.NewSQLiteServerRepo(tx)
		txRoleRepo := repository.NewSQLiteRoleRepo(tx)
		txChannelRepo := repository.NewSQLiteChannelRepo(tx)
		txCategoryRepo := repository.NewSQLiteCategoryRepo(tx)

		if err := txServerRepo.Create(ctx, server); err != nil {
			return fmt.Errorf("failed to create server: %w", err)
		}

		if err := txServerRepo.AddMember(ctx, server.ID, ownerID); err != nil {
			return fmt.Errorf("failed to add owner as member: %w", err)
		}

		// Default "everyone" role
		defaultPerms := models.PermViewChannel | models.PermReadMessages | models.PermSendMessages |
			models.PermConnectVoice | models.PermSpeak | models.PermUseSoundboard

		defaultRole := &models.Role{
			ServerID:    server.ID,
			Name:        "everyone",
			Color:       "#99AAB5",
			Position:    1,
			Permissions: defaultPerms,
			IsDefault:   true,
			Mentionable: true,
		}
		if err := txRoleRepo.Create(ctx, defaultRole); err != nil {
			return fmt.Errorf("failed to create default role: %w", err)
		}

		// Owner role — highest position, full permissions
		ownerRole := &models.Role{
			ServerID:    server.ID,
			Name:        "Owner",
			Color:       "#E74C3C",
			Position:    100,
			Permissions: models.PermAll,
			IsOwner:     true,
		}
		if err := txRoleRepo.Create(ctx, ownerRole); err != nil {
			return fmt.Errorf("failed to create owner role: %w", err)
		}

		if err := txRoleRepo.AssignToUser(ctx, ownerID, defaultRole.ID, server.ID); err != nil {
			return fmt.Errorf("failed to assign default role to owner: %w", err)
		}
		if err := txRoleRepo.AssignToUser(ctx, ownerID, ownerRole.ID, server.ID); err != nil {
			return fmt.Errorf("failed to assign owner role: %w", err)
		}

		// Default categories + channels
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

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("failed to create server (transaction): %w", err)
	}

	// WS broadcast (after commit)
	s.hub.AddClientServerID(ownerID, server.ID)
	s.hub.BroadcastToUser(ownerID, ws.Event{
		Op: ws.OpServerCreate,
		Data: models.ServerListItem{
			ID:      server.ID,
			Name:    server.Name,
			IconURL: s.urlSigner.SignURLPtr(server.IconURL),
		},
	})

	log.Printf("[server] created server %s (name=%s, owner=%s, host=%s)",
		server.ID, server.Name, ownerID, req.HostType)

	return server, nil
}

func (s *serverService) GetServer(ctx context.Context, serverID string) (*models.Server, error) {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}
	server.IconURL = s.urlSigner.SignURLPtr(server.IconURL)
	return server, nil
}

func (s *serverService) GetServerRaw(ctx context.Context, serverID string) (*models.Server, error) {
	return s.serverRepo.GetByID(ctx, serverID)
}

func (s *serverService) GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error) {
	servers, err := s.serverRepo.GetUserServers(ctx, userID)
	if err != nil {
		return nil, err
	}
	for i := range servers {
		servers[i].IconURL = s.urlSigner.SignURLPtr(servers[i].IconURL)
	}
	return servers, nil
}

func (s *serverService) UpdateServer(ctx context.Context, serverID string, req *models.UpdateServerRequest) (*models.Server, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}

	if req.Name != nil {
		server.Name = *req.Name
	}
	if req.InviteRequired != nil {
		server.InviteRequired = *req.InviteRequired
	}
	if req.E2EEEnabled != nil {
		server.E2EEEnabled = *req.E2EEEnabled
	}
	if req.AFKTimeoutMinutes != nil {
		server.AFKTimeoutMinutes = *req.AFKTimeoutMinutes
	}

	if err := s.serverRepo.Update(ctx, server); err != nil {
		return nil, fmt.Errorf("failed to update server: %w", err)
	}

	// LiveKit credential update (self-hosted only)
	if req.HasLiveKitUpdate() {
		if server.LiveKitInstanceID == nil {
			return nil, fmt.Errorf("%w: this server has no LiveKit instance", pkg.ErrBadRequest)
		}

		instance, err := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
		if err != nil {
			return nil, fmt.Errorf("failed to get livekit instance: %w", err)
		}
		if instance.IsPlatformManaged {
			return nil, fmt.Errorf("%w: cannot modify platform-managed LiveKit instance", pkg.ErrForbidden)
		}

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

	server.IconURL = s.urlSigner.SignURLPtr(server.IconURL)
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

	server.IconURL = s.urlSigner.SignURLPtr(server.IconURL)
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

	if server.OwnerID != userID {
		return fmt.Errorf("%w: only the server owner can delete the server", pkg.ErrForbidden)
	}

	// LiveKit cleanup: delete self-hosted instance, decrement platform instance
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

	// Broadcast before delete (server_members are needed for BroadcastToServer)
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

// JoinServer joins a server via invite code.
func (s *serverService) JoinServer(ctx context.Context, userID, inviteCode string) (*models.Server, error) {
	invite, err := s.inviteService.ValidateAndUse(ctx, inviteCode)
	if err != nil {
		return nil, err
	}

	serverID := invite.ServerID

	isMember, err := s.serverRepo.IsMember(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check membership: %w", err)
	}
	if isMember {
		return nil, fmt.Errorf("%w: already a member of this server", pkg.ErrBadRequest)
	}

	if err := s.serverRepo.AddMember(ctx, serverID, userID); err != nil {
		return nil, fmt.Errorf("failed to add member: %w", err)
	}

	// Assign default role
	defaultRole, err := s.roleRepo.GetDefaultByServer(ctx, serverID)
	if err != nil {
		log.Printf("[server] failed to get default role for server %s: %v", serverID, err)
	} else {
		if err := s.roleRepo.AssignToUser(ctx, userID, defaultRole.ID, serverID); err != nil {
			log.Printf("[server] failed to assign default role: %v", err)
		}
	}

	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get server: %w", err)
	}

	// Add server to user's WS subscription list
	s.hub.AddClientServerID(userID, serverID)

	// Notify user: server added to their list
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpServerCreate,
		Data: models.ServerListItem{
			ID:      server.ID,
			Name:    server.Name,
			IconURL: s.urlSigner.SignURLPtr(server.IconURL),
		},
	})

	// Notify server members: new member joined (full MemberWithRoles for frontend)
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		log.Printf("[server] failed to get user %s for member_join broadcast: %v", userID, err)
	} else {
		roles, _ := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
		member := models.ToMemberWithRoles(user, roles)
		member.AvatarURL = s.urlSigner.SignURLPtr(member.AvatarURL)
		s.hub.BroadcastToServer(serverID, ws.Event{
			Op:   ws.OpMemberJoin,
			Data: member,
		})
	}

	log.Printf("[server] user %s joined server %s via invite", userID, serverID)
	server.IconURL = s.urlSigner.SignURLPtr(server.IconURL)
	return server, nil
}

func (s *serverService) LeaveServer(ctx context.Context, serverID, userID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	if server.OwnerID == userID {
		return fmt.Errorf("%w: server owner cannot leave; transfer ownership first", pkg.ErrForbidden)
	}

	if err := s.serverRepo.RemoveMember(ctx, serverID, userID); err != nil {
		return fmt.Errorf("failed to remove member: %w", err)
	}

	// Notify server members (broadcast before removing subscription)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpMemberLeave,
		Data: map[string]string{
			"server_id": serverID,
			"user_id":   userID,
		},
	})

	// Notify user: server removed from their list
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	// Remove from WS subscription list
	s.hub.RemoveClientServerID(userID, serverID)

	log.Printf("[server] user %s left server %s", userID, serverID)
	return nil
}

// GetLiveKitSettings returns non-secret LiveKit info for the settings page.
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

// ReorderServers updates the user's personal server list order (per-user, no broadcast).
func (s *serverService) ReorderServers(ctx context.Context, userID string, req *models.ReorderServersRequest) ([]models.ServerListItem, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if err := s.serverRepo.UpdateMemberPositions(ctx, userID, req.Items); err != nil {
		return nil, fmt.Errorf("failed to update server positions: %w", err)
	}

	servers, err := s.serverRepo.GetUserServers(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload servers after reorder: %w", err)
	}
	for i := range servers {
		servers[i].IconURL = s.urlSigner.SignURLPtr(servers[i].IconURL)
	}
	return servers, nil
}
