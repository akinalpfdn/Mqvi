package services

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"

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
	UpdateBanner(ctx context.Context, serverID, bannerURL string) (*models.Server, error)
	// DeleteServer soft-deletes the server. Files and LiveKit instance are preserved.
	// Use HardDeleteServer to permanently remove (skip 30-day TTL).
	DeleteServer(ctx context.Context, serverID, userID string) error
	// RestoreServer un-soft-deletes the server. Owner can only restore servers they soft-deleted
	// themselves; admin-deleted servers can only be restored by an admin.
	RestoreServer(ctx context.Context, serverID, userID string) error
	// HardDeleteServer permanently deletes a soft-deleted server (skip 30-day TTL).
	// Files cleaned, LiveKit instance released, DB cascade.
	HardDeleteServer(ctx context.Context, serverID, userID string) error
	// GetDeletedServers returns soft-deleted servers owned by this user (for restore UI).
	GetDeletedServers(ctx context.Context, userID string) ([]models.DeletedServerInfo, error)
	JoinServer(ctx context.Context, userID, inviteCode string) (*JoinResult, error)
	JoinPublicServer(ctx context.Context, userID, serverID string) (*JoinResult, error)
	// Join approval — pending requesters live in a separate table, never in server_members.
	ApproveRequest(ctx context.Context, serverID, targetUserID string) error
	RejectRequest(ctx context.Context, serverID, targetUserID string) error
	ListRequests(ctx context.Context, serverID string) ([]models.ServerJoinRequestWithUser, error)
	CountRequests(ctx context.Context, serverID string) (int, error)
	LeaveServer(ctx context.Context, serverID, userID string) error
	GetLiveKitSettings(ctx context.Context, serverID string) (*LiveKitSettings, error)
	// ReorderServers updates the user's personal server list order. No WS broadcast.
	ReorderServers(ctx context.Context, userID string, req *models.ReorderServersRequest) ([]models.ServerListItem, error)
}

// MaxMqviHostedServersPerUser caps how many mqvi-hosted servers a single
// non-admin user can own. Self-hosted servers (user provides own LiveKit) are
// unlimited. The frontend matches on the "max_servers_reached" error code and
// hard-codes the same number in the i18n string — keep both in sync.
const MaxMqviHostedServersPerUser = 3

// VoiceStateSyncer pushes a server's in-progress voice participants to a single
// user — used on server join so a newcomer sees active calls without reconnecting.
type VoiceStateSyncer interface {
	SyncServerStatesToUser(userID, serverID string)
}

// VoiceServerDisconnector tears down every voice participant across a server's channels
// when the server is deleted (enumerate by server, then DisconnectUser each: broadcast
// leave + LiveKit remove + free passphrase + stop timers). Without it, deleting a server
// leaves ghost in-memory voice state and running channel timers.
type VoiceServerDisconnector interface {
	GetServerParticipants(serverID string) []models.VoiceState
	DisconnectUser(userID string)
}

type serverService struct {
	db            *sql.DB // for WithTx in CreateServer
	serverRepo    repository.ServerRepository
	livekitRepo   repository.LiveKitRepository
	roleRepo      repository.RoleRepository
	channelRepo   repository.ChannelRepository
	categoryRepo  repository.CategoryRepository
	userRepo        repository.UserRepository
	banRepo         repository.BanRepository
	joinRequestRepo repository.JoinRequestRepository
	inviteService   InviteService
	hub             ws.BroadcastAndManage
	voiceSync       VoiceStateSyncer
	voiceDisc       VoiceServerDisconnector
	encryptionKey   []byte // AES-256-GCM for LiveKit credentials
	urlSigner       FileURLSigner
	fileCleanup     FileCleanupService
}

func NewServerService(
	db *sql.DB,
	serverRepo repository.ServerRepository,
	livekitRepo repository.LiveKitRepository,
	roleRepo repository.RoleRepository,
	channelRepo repository.ChannelRepository,
	categoryRepo repository.CategoryRepository,
	userRepo repository.UserRepository,
	banRepo repository.BanRepository,
	joinRequestRepo repository.JoinRequestRepository,
	inviteService InviteService,
	hub ws.BroadcastAndManage,
	voiceSync VoiceStateSyncer,
	voiceDisc VoiceServerDisconnector,
	encryptionKey []byte,
	urlSigner FileURLSigner,
	fileCleanup FileCleanupService,
) ServerService {
	return &serverService{
		db:              db,
		serverRepo:      serverRepo,
		livekitRepo:     livekitRepo,
		roleRepo:        roleRepo,
		channelRepo:     channelRepo,
		categoryRepo:    categoryRepo,
		userRepo:        userRepo,
		banRepo:         banRepo,
		joinRequestRepo: joinRequestRepo,
		inviteService:   inviteService,
		hub:             hub,
		voiceSync:       voiceSync,
		voiceDisc:       voiceDisc,
		encryptionKey:   encryptionKey,
		urlSigner:       urlSigner,
		fileCleanup:     fileCleanup,
	}
}

// CreateServer creates a new server atomically (server + membership + roles + channels in one tx).
func (s *serverService) CreateServer(ctx context.Context, ownerID string, req *models.CreateServerRequest) (*models.Server, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Non-admin users can own at most MaxMqviHostedServersPerUser mqvi-hosted servers.
	// Self-hosted servers are unlimited (the user provides their own LiveKit instance).
	// Frontend matches on the stable error code "max_servers_reached" to show a
	// localized message — keep that string stable.
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
			if count >= MaxMqviHostedServersPerUser {
				return nil, fmt.Errorf("%w: max_servers_reached", pkg.ErrBadRequest)
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
		IsPublic:          false,
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
			Mentionable: true,
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
			ID:          server.ID,
			Name:        server.Name,
			IconURL:     s.urlSigner.SignURLPtr(server.IconURL),
			E2EEEnabled: server.E2EEEnabled,
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
	server.BannerURL = s.urlSigner.SignURLPtr(server.BannerURL)
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

// nilIfEmpty returns nil for an empty string so optional text columns store NULL, not "".
func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
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
	if req.IsPublic != nil {
		server.IsPublic = *req.IsPublic
	}
	if req.E2EEEnabled != nil {
		server.E2EEEnabled = *req.E2EEEnabled
	}
	if req.ApprovalRequired != nil {
		server.ApprovalRequired = *req.ApprovalRequired
	}
	if req.Description != nil {
		server.Description = nilIfEmpty(*req.Description)
	}
	if req.Category != nil {
		server.Category = nilIfEmpty(*req.Category)
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
	server.BannerURL = s.urlSigner.SignURLPtr(server.BannerURL)
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
	server.BannerURL = s.urlSigner.SignURLPtr(server.BannerURL)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerUpdate,
		Data: server,
	})

	return server, nil
}

func (s *serverService) UpdateBanner(ctx context.Context, serverID, bannerURL string) (*models.Server, error) {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}

	server.BannerURL = &bannerURL

	if err := s.serverRepo.Update(ctx, server); err != nil {
		return nil, fmt.Errorf("failed to update server banner: %w", err)
	}

	server.IconURL = s.urlSigner.SignURLPtr(server.IconURL)
	server.BannerURL = s.urlSigner.SignURLPtr(server.BannerURL)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerUpdate,
		Data: server,
	})

	return server, nil
}

// DeleteServer soft-deletes the server. Files, LiveKit instance, and member roles
// are preserved for restore. Worker hard-deletes after 30-day TTL (Phase 16 P3).
func (s *serverService) DeleteServer(ctx context.Context, serverID, userID string) error {
	server, err := s.serverRepo.GetActiveByID(ctx, serverID)
	if err != nil {
		return err
	}

	if server.OwnerID != userID {
		return fmt.Errorf("%w: only the server owner can delete the server", pkg.ErrForbidden)
	}

	if err := s.serverRepo.SoftDelete(ctx, serverID, userID, false); err != nil {
		return fmt.Errorf("failed to soft delete server: %w", err)
	}

	// Members hide the server in their UI on this event.
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	// Authoritatively tear down any voice participants across the server's channels.
	disconnectServerVoiceParticipants(s.voiceDisc, serverID)

	log.Printf("[server] soft-deleted server %s by owner %s", serverID, userID)
	return nil
}

// disconnectServerVoiceParticipants force-disconnects every voice participant across a
// server's channels: clears ghost in-memory state, removes LiveKit participants, stops
// channel timers. Shared by every server-delete path (owner + admin). Best-effort; a nil
// disconnector or empty server is a no-op.
func disconnectServerVoiceParticipants(vd VoiceServerDisconnector, serverID string) {
	if vd == nil {
		return
	}
	for _, p := range vd.GetServerParticipants(serverID) {
		vd.DisconnectUser(p.UserID)
	}
}

// RestoreServer un-soft-deletes a server. Owner can only restore servers they soft-deleted
// themselves; admin-deleted servers (deleted_by_admin=1) are not restorable by the owner.
func (s *serverService) RestoreServer(ctx context.Context, serverID, userID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	if server.OwnerID != userID {
		return fmt.Errorf("%w: only the server owner can restore the server", pkg.ErrForbidden)
	}

	if server.DeletedAt == nil {
		return fmt.Errorf("%w: server is not deleted", pkg.ErrBadRequest)
	}

	if server.DeletedByAdmin {
		return fmt.Errorf("%w: server was deleted by an admin and cannot be restored by the owner", pkg.ErrForbidden)
	}

	if err := s.serverRepo.Restore(ctx, serverID); err != nil {
		return fmt.Errorf("failed to restore server: %w", err)
	}

	s.broadcastServerRestore(ctx, serverID)

	log.Printf("[server] restored server %s by owner %s", serverID, userID)
	return nil
}

// broadcastServerRestore notifies all server members that a soft-deleted server
// is back. We can't use BroadcastToServer alone because members who reconnected
// while the server was soft-deleted are NOT in hub.serverClients[serverID]
// (their client.serverIDs filter excluded the deleted server on connect).
// Approach: re-subscribe each online member via AddClientServerID, then send
// the event via BroadcastToUser so offline members are silent no-ops.
func (s *serverService) broadcastServerRestore(ctx context.Context, serverID string) {
	restored, err := s.serverRepo.GetActiveByID(ctx, serverID)
	if err != nil || restored == nil {
		return
	}

	memberIDs, err := s.serverRepo.GetMemberUserIDs(ctx, serverID)
	if err != nil {
		log.Printf("[server] failed to list members for restore broadcast %s: %v", serverID, err)
		return
	}

	event := ws.Event{Op: ws.OpServerRestore, Data: restored}
	for _, uid := range memberIDs {
		// Re-subscribe online members to this server's broadcast index.
		// AddClientServerID is a no-op for offline users.
		s.hub.AddClientServerID(uid, serverID)
		s.hub.BroadcastToUser(uid, event)
	}
}

// HardDeleteServer permanently deletes a soft-deleted server (skip 30-day TTL).
// Files cleaned, LiveKit instance released, DB cascade removes channels/messages/etc.
func (s *serverService) HardDeleteServer(ctx context.Context, serverID, userID string) error {
	// Use GetByID — server must be soft-deleted to be hard-deletable by owner
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	if server.OwnerID != userID {
		return fmt.Errorf("%w: only the server owner can permanently delete the server", pkg.ErrForbidden)
	}

	if server.DeletedAt == nil {
		return fmt.Errorf("%w: server must be soft-deleted before permanent deletion", pkg.ErrBadRequest)
	}

	if server.DeletedByAdmin {
		return fmt.Errorf("%w: admin-deleted server cannot be permanently deleted by owner", pkg.ErrForbidden)
	}

	// Phase 1: collect file refs (also collects LiveKit instance for cleanup)
	plan, err := s.fileCleanup.CollectServerFiles(ctx, serverID)
	if err != nil {
		return fmt.Errorf("failed to collect server files: %w", err)
	}

	// Phase 2: DB delete (CASCADE removes channels, messages, attachments, etc.)
	if err := s.serverRepo.Delete(ctx, serverID); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}

	// Defensive: participants were disconnected on the original soft-delete, but a
	// rejoin between soft- and hard-delete would leave ghosts — tear down again.
	disconnectServerVoiceParticipants(s.voiceDisc, serverID)

	// Phase 3: file cleanup + LiveKit cleanup (server_delete WS event already
	// broadcast on the original soft-delete; no need to re-broadcast).
	s.fileCleanup.Execute(plan)

	log.Printf("[server] hard-deleted server %s by owner %s", serverID, userID)
	return nil
}

// GetDeletedServers returns soft-deleted servers owned by this user with countdown info.
func (s *serverService) GetDeletedServers(ctx context.Context, userID string) ([]models.DeletedServerInfo, error) {
	servers, err := s.serverRepo.ListDeletedByOwner(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list deleted servers: %w", err)
	}

	result := make([]models.DeletedServerInfo, 0, len(servers))
	for _, srv := range servers {
		iconURL := s.urlSigner.SignURLPtr(srv.IconURL)
		var deletedAt time.Time
		if srv.DeletedAt != nil {
			deletedAt = *srv.DeletedAt
		}
		result = append(result, models.DeletedServerInfo{
			ID:                srv.ID,
			Name:              srv.Name,
			IconURL:           iconURL,
			DeletedAt:         deletedAt,
			DeletedByAdmin:    srv.DeletedByAdmin,
			PermanentDeleteAt: deletedAt.AddDate(0, 0, models.SoftDeleteTTLDays),
		})
	}
	return result, nil
}

// JoinResult is what JoinServer returns: the joined server, or a Pending flag when the
// server requires approval (a request was created rather than a membership).
type JoinResult struct {
	Server  *models.Server `json:"server,omitempty"`
	Pending bool           `json:"pending"`
}

// maxPendingRequestsPerServer bounds a server's join-request queue so it can't grow
// without limit. Generous — admins clear the queue; this is a safety valve, not a gate.
const maxPendingRequestsPerServer = 1000

// JoinServer handles an invite join. A server-scoped ban is rejected up front, shared by
// BOTH paths, so a banned user can neither join directly nor slip into the approval queue.
// If the server requires approval, a pending request is created (invite validated but NOT
// consumed — the admin is the gate); otherwise the user is promoted immediately, consuming
// the invite use exactly as before.
func (s *serverService) JoinServer(ctx context.Context, userID, inviteCode string) (*JoinResult, error) {
	invite, err := s.inviteService.Validate(ctx, inviteCode)
	if err != nil {
		return nil, err
	}
	serverID := invite.ServerID

	banned, err := s.banRepo.Exists(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check ban: %w", err)
	}
	if banned {
		return nil, fmt.Errorf("%w: you are banned from this server", pkg.ErrForbidden)
	}

	isMember, err := s.serverRepo.IsMember(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check membership: %w", err)
	}
	if isMember {
		return nil, fmt.Errorf("%w: already a member of this server", pkg.ErrBadRequest)
	}

	server, err := s.serverRepo.GetActiveByID(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get server: %w", err)
	}

	// Approval required → create a pending request instead of joining. The invite is NOT
	// consumed (admin is the gate); a re-request while one is pending is idempotent.
	if server.ApprovalRequired {
		count, err := s.joinRequestRepo.CountByServer(ctx, serverID)
		if err != nil {
			return nil, fmt.Errorf("failed to count join requests: %w", err)
		}
		// Only block a NEW requester over the cap — an existing pending request re-requesting
		// is idempotent and must not be rejected.
		if count >= maxPendingRequestsPerServer {
			if exists, _ := s.joinRequestRepo.Exists(ctx, serverID, userID); !exists {
				return nil, fmt.Errorf("%w: this server's join queue is full, try again later", pkg.ErrBadRequest)
			}
		}
		if err := s.joinRequestRepo.Create(ctx, serverID, userID, inviteCode); err != nil {
			return nil, err
		}
		s.broadcastJoinRequestCount(ctx, serverID)
		log.Printf("[server] user %s requested to join server %s (approval required)", userID, serverID)
		return &JoinResult{Pending: true}, nil
	}

	joined, err := s.promoteToMember(ctx, server, userID, inviteCode, true)
	if err != nil {
		return nil, err
	}
	return &JoinResult{Server: joined}, nil
}

// JoinPublicServer joins (or requests to join) a public server straight from the discovery
// directory — no invite involved. Rejects non-public servers and bans, and honors
// approval_required exactly like the invite path.
func (s *serverService) JoinPublicServer(ctx context.Context, userID, serverID string) (*JoinResult, error) {
	server, err := s.serverRepo.GetActiveByID(ctx, serverID)
	if err != nil {
		return nil, err
	}
	if !server.IsPublic {
		return nil, fmt.Errorf("%w: this server is not public", pkg.ErrForbidden)
	}

	banned, err := s.banRepo.Exists(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check ban: %w", err)
	}
	if banned {
		return nil, fmt.Errorf("%w: you are banned from this server", pkg.ErrForbidden)
	}

	isMember, err := s.serverRepo.IsMember(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check membership: %w", err)
	}
	if isMember {
		return nil, fmt.Errorf("%w: already a member of this server", pkg.ErrBadRequest)
	}

	// Approval required → queue a request instead of joining (no invite to record).
	if server.ApprovalRequired {
		count, err := s.joinRequestRepo.CountByServer(ctx, serverID)
		if err != nil {
			return nil, fmt.Errorf("failed to count join requests: %w", err)
		}
		if count >= maxPendingRequestsPerServer {
			if exists, _ := s.joinRequestRepo.Exists(ctx, serverID, userID); !exists {
				return nil, fmt.Errorf("%w: this server's join queue is full, try again later", pkg.ErrBadRequest)
			}
		}
		if err := s.joinRequestRepo.Create(ctx, serverID, userID, ""); err != nil {
			return nil, err
		}
		s.broadcastJoinRequestCount(ctx, serverID)
		log.Printf("[server] user %s requested to join public server %s (approval required)", userID, serverID)
		return &JoinResult{Pending: true}, nil
	}

	joined, err := s.promoteToMember(ctx, server, userID, "", false)
	if err != nil {
		return nil, err
	}
	return &JoinResult{Server: joined}, nil
}

// promoteToMember runs the full "become a member" sequence: (optionally) consume the invite,
// add membership, assign the default role, subscribe the socket, and broadcast join events.
// consumeInvite is true for direct joins and false for admin approvals (admin is the gate).
// The invite use is consumed only AFTER the atomic max_uses guard, and released back if the
// membership add then fails (compensation). Returns the server with a signed icon URL.
func (s *serverService) promoteToMember(ctx context.Context, server *models.Server, userID, inviteCode string, consumeInvite bool) (*models.Server, error) {
	serverID := server.ID

	if consumeInvite {
		if err := s.inviteService.Consume(ctx, inviteCode); err != nil {
			return nil, err
		}
	}

	if err := s.serverRepo.AddMember(ctx, serverID, userID); err != nil {
		if consumeInvite {
			if relErr := s.inviteService.ReleaseUse(ctx, inviteCode); relErr != nil {
				log.Printf("[server] failed to release invite use after add failure (code=%s): %v", inviteCode, relErr)
			}
		}
		return nil, fmt.Errorf("failed to add member: %w", err)
	}

	// A member never keeps a pending join request. Clears any lingering request whether the user
	// joined directly, approval was toggled off mid-request, or a request raced an approval. No-op
	// in the approval path (ApproveRequest already claimed the row via its own delete).
	if _, err := s.joinRequestRepo.Delete(ctx, serverID, userID); err != nil {
		log.Printf("[server] failed to clear join request after join (server=%s user=%s): %v", serverID, userID, err)
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

	// Add server to user's WS subscription list
	s.hub.AddClientServerID(userID, serverID)

	// Notify user: server added to their list
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpServerCreate,
		Data: models.ServerListItem{
			ID:          server.ID,
			Name:        server.Name,
			IconURL:     s.urlSigner.SignURLPtr(server.IconURL),
			E2EEEnabled: server.E2EEEnabled,
		},
	})

	// Push in-progress voice participants so the newcomer sees active calls immediately.
	s.voiceSync.SyncServerStatesToUser(userID, serverID)

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

	log.Printf("[server] user %s became a member of server %s", userID, serverID)
	server.IconURL = s.urlSigner.SignURLPtr(server.IconURL)
	server.BannerURL = s.urlSigner.SignURLPtr(server.BannerURL)
	return server, nil
}

// ApproveRequest promotes a pending requester to a member (perm-gated at the route).
// Concurrency-safe: the request delete is the atomic claim — only the caller that actually
// removes the row promotes the user, so two racing approvers can't double-add or double-broadcast.
func (s *serverService) ApproveRequest(ctx context.Context, serverID, targetUserID string) error {
	server, err := s.serverRepo.GetActiveByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("failed to get server: %w", err)
	}

	claimed, err := s.joinRequestRepo.Delete(ctx, serverID, targetUserID)
	if err != nil {
		return err
	}
	if !claimed {
		return fmt.Errorf("%w: no pending join request", pkg.ErrNotFound)
	}

	if _, err := s.promoteToMember(ctx, server, targetUserID, "", false); err != nil {
		// Compensation: we claimed (deleted) the request but couldn't add the member —
		// restore it so the request isn't silently lost.
		if reErr := s.joinRequestRepo.Create(ctx, serverID, targetUserID, ""); reErr != nil {
			log.Printf("[server] approve failed and could not restore request (server=%s user=%s): %v / %v", serverID, targetUserID, err, reErr)
		}
		return fmt.Errorf("failed to approve join request: %w", err)
	}

	s.broadcastJoinRequestCount(ctx, serverID)
	log.Printf("[server] approved join request: user %s -> server %s", targetUserID, serverID)
	return nil
}

// RejectRequest silently removes a pending request (perm-gated at the route).
func (s *serverService) RejectRequest(ctx context.Context, serverID, targetUserID string) error {
	deleted, err := s.joinRequestRepo.Delete(ctx, serverID, targetUserID)
	if err != nil {
		return err
	}
	if !deleted {
		return fmt.Errorf("%w: no pending join request", pkg.ErrNotFound)
	}
	s.broadcastJoinRequestCount(ctx, serverID)
	log.Printf("[server] rejected join request: user %s x server %s", targetUserID, serverID)
	return nil
}

// ListRequests returns pending requests with the requester's profile (signed avatars).
func (s *serverService) ListRequests(ctx context.Context, serverID string) ([]models.ServerJoinRequestWithUser, error) {
	reqs, err := s.joinRequestRepo.ListByServer(ctx, serverID)
	if err != nil {
		return nil, err
	}
	for i := range reqs {
		reqs[i].AvatarURL = s.urlSigner.SignURLPtr(reqs[i].AvatarURL)
	}
	return reqs, nil
}

// CountRequests returns the number of pending requests for a server.
func (s *serverService) CountRequests(ctx context.Context, serverID string) (int, error) {
	return s.joinRequestRepo.CountByServer(ctx, serverID)
}

// broadcastJoinRequestCount pushes the server's current pending-request count to all members;
// only PermApproveMembers holders render it. Request data stays behind the perm-gated list
// endpoint, so the count event leaks nothing sensitive.
func (s *serverService) broadcastJoinRequestCount(ctx context.Context, serverID string) {
	count, err := s.joinRequestRepo.CountByServer(ctx, serverID)
	if err != nil {
		log.Printf("[server] failed to count join requests for broadcast (server=%s): %v", serverID, err)
		return
	}
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpJoinRequestUpdate,
		Data: map[string]any{
			"server_id":     serverID,
			"pending_count": count,
		},
	})
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
