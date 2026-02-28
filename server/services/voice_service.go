// Package services, voice (ses) iş mantığını yönetir.
//
// VoiceService sorumluluları:
// 1. LiveKit token generate etme (ses kanalına katılım için)
// 2. In-memory voice state yönetimi (kim hangi kanalda, mute/deafen/stream)
// 3. State değişikliklerini WS Hub üzerinden broadcast etme
//
// Multi-server mimaride her sunucu kendi LiveKit instance'ına bağlıdır.
// Token generation sırasında: channel → server → livekit_instance lookup yapılır,
// credential'lar AES-256-GCM ile decrypt edilir ve token üretilir.
//
// Neden in-memory (DB değil)?
// Voice state geçicidir — sunucu yeniden başlatıldığında tüm WS
// bağlantıları da düşer. DB'ye yazmak gereksiz I/O olur.
// sync.RWMutex ile concurrent erişim güvenliği sağlanır.
//
// Room name format: "{serverID}:{channelID}" — farklı sunuculardaki aynı
// channel_id'li kanalların LiveKit'te çakışmaması için.
package services

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/ws"

	// LiveKit Go SDK — token generation için.
	// `auth` paketi JWT token oluşturma API'sini sağlar.
	"github.com/livekit/protocol/auth"
)

// ─── ISP Interface'leri ───
//
// Interface Segregation Principle: VoiceService sadece ihtiyacı olan
// metotlara bağımlı olur, tüm repository interface'ine değil.
// Bu sayede circular dependency oluşmaz ve test edilebilirlik artar.

// ChannelGetter, kanal bilgisi almak için minimal interface.
// repository.ChannelRepository bu interface'i Go'nun duck typing'i
// sayesinde otomatik olarak karşılar — explicit implement gerekmez.
type ChannelGetter interface {
	GetByID(ctx context.Context, id string) (*models.Channel, error)
}

// LiveKitInstanceGetter, sunucuya bağlı LiveKit instance bilgisi almak için ISP interface.
// repository.LiveKitRepository bu interface'i Go duck typing ile karşılar.
type LiveKitInstanceGetter interface {
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
}

// ─── VoiceService Interface ───

// VoiceService, ses kanalı operasyonları için iş mantığı interface'i.
type VoiceService interface {
	// GenerateToken, LiveKit JWT oluşturur. Permission kontrolü içerir.
	// displayName tercih edilen görünen isimdir — LiveKit'te participant.name olarak kullanılır.
	// Kanal → sunucu → LiveKit instance lookup yaparak per-server token üretir.
	GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)

	// JoinChannel, kullanıcıyı ses kanalına kaydeder ve broadcast eder.
	// Kullanıcı başka bir kanalda ise önce oradan çıkarılır.
	// displayName boş ise username gösterilir.
	JoinChannel(userID, username, displayName, avatarURL, channelID string) error

	// LeaveChannel, kullanıcıyı mevcut ses kanalından çıkarır.
	LeaveChannel(userID string) error

	// UpdateState, mute/deafen/streaming durumunu günceller.
	UpdateState(userID string, isMuted, isDeafened, isStreaming *bool) error

	// GetChannelParticipants, bir ses kanalındaki tüm kullanıcıları döner.
	GetChannelParticipants(channelID string) []models.VoiceState

	// GetUserVoiceState, kullanıcının anlık ses durumunu döner (nil = kanalda değil).
	GetUserVoiceState(userID string) *models.VoiceState

	// GetAllVoiceStates, tüm aktif ses durumlarını döner (WS connect sync için).
	GetAllVoiceStates() []models.VoiceState

	// DisconnectUser, kullanıcıyı ses kanalından çıkarır (WS disconnect cleanup).
	DisconnectUser(userID string)

	// GetStreamCount, bir kanaldaki aktif ekran paylaşımı sayısını döner.
	GetStreamCount(channelID string) int

	// AdminUpdateState, yetkili bir kullanıcının başka bir kullanıcıyı server mute/deafen yapmasını sağlar.
	// PermMuteMembers veya PermDeafenMembers yetkisi gerektirir (hedef kullanıcının kanalında).
	// Pointer parametreler: nil ise o alan değiştirilmez (partial update).
	AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error

	// MoveUser, bir kullanıcıyı mevcut ses kanalından başka bir ses kanalına taşır.
	// Taşıyan kişinin HER İKİ kanalda da PermMoveMembers yetkisi olmalıdır.
	MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error

	// AdminDisconnectUser, bir kullanıcıyı ses kanalından atar.
	// Atan kişinin hedef kullanıcının bulunduğu kanalda PermMoveMembers yetkisi olmalıdır.
	// (Discord'da da Disconnect = Move Members yetkisine bağlıdır.)
	AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error
}

// ─── Implementasyon ───

// voiceService, VoiceService interface'inin concrete implementasyonu.
// Küçük harf ile başlar — package dışından erişilemez (encapsulation).
// Dış dünya sadece VoiceService interface'ini görür.
type voiceService struct {
	// In-memory state: userID → VoiceState
	// Neden userID key? Bir kullanıcı aynı anda tek bir ses kanalında olabilir.
	states map[string]*models.VoiceState

	// sync.RWMutex: Concurrent erişim koruması.
	// RLock: Birden fazla okuyucu aynı anda erişebilir (GetChannelParticipants gibi).
	// Lock: Yazma sırasında tüm erişim bloklanır (JoinChannel, LeaveChannel gibi).
	mu sync.RWMutex

	// Dependency'ler — interface üzerinden enjekte edilir (DI)
	channelGetter  ChannelGetter
	livekitGetter  LiveKitInstanceGetter // sunucu → LiveKit instance lookup
	permResolver   ChannelPermResolver   // Kanal bazlı permission override çözümleme (rol + channel override)
	hub            ws.EventPublisher
	encryptionKey  []byte // AES-256-GCM key — LiveKit credential'ları decrypt etmek için
}

// maxScreenShares — bir ses kanalında aynı anda izin verilen
// maksimum ekran paylaşımı sayısı. 0 = sınırsız.
const maxScreenShares = 0

// NewVoiceService, yeni bir VoiceService oluşturur.
// Constructor injection pattern: tüm dependency'ler parametre olarak alınır.
//
// Multi-server mimaride livekitCfg yerine livekitGetter + encryptionKey kullanılır:
// - livekitGetter: sunucuya bağlı LiveKit instance'ını DB'den çeker
// - encryptionKey: credential'ları AES-256-GCM ile decrypt etmek için
// - permResolver: Kanal bazlı permission override çözümleme — ConnectVoice, Speak, Stream
//   kontrolünde rol + kanal override birlikte hesaplanır.
func NewVoiceService(
	channelGetter ChannelGetter,
	livekitGetter LiveKitInstanceGetter,
	permResolver ChannelPermResolver,
	hub ws.EventPublisher,
	encryptionKey []byte,
) VoiceService {
	return &voiceService{
		states:        make(map[string]*models.VoiceState),
		channelGetter: channelGetter,
		livekitGetter: livekitGetter,
		permResolver:  permResolver,
		hub:           hub,
		encryptionKey: encryptionKey,
	}
}

// ─── Token Generation ───

func (s *voiceService) GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error) {
	// 1. Kanal var mı ve voice tipinde mi?
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.Type != models.ChannelTypeVoice {
		return nil, fmt.Errorf("%w: not a voice channel", pkg.ErrBadRequest)
	}

	// 2. Sunucuya bağlı LiveKit instance'ı al
	//
	// channel.ServerID → servers.livekit_instance_id → livekit_instances
	// Her sunucu kendi LiveKit instance'ına bağlıdır.
	lkInstance, err := s.livekitGetter.GetByServerID(ctx, channel.ServerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance for server %s: %w", channel.ServerID, err)
	}

	// 3. Credential'ları AES-256-GCM ile decrypt et
	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt livekit api key: %w", err)
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt livekit api secret: %w", err)
	}

	// 4. Kanal bazlı effective permissions hesapla (override'lar dahil)
	//
	// ResolveChannelPermissions, Discord algoritmasını uygular:
	// base (tüm rollerin OR'u) + channel override'lar (allow/deny).
	// Admin yetkisi tüm override'ları bypass eder.
	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}

	// 5. PermConnectVoice kontrolü
	if !effectivePerms.Has(models.PermConnectVoice) {
		return nil, fmt.Errorf("%w: missing voice connect permission", pkg.ErrForbidden)
	}

	// 6. UserLimit kontrolü (0 = sınırsız)
	if channel.UserLimit > 0 {
		participants := s.GetChannelParticipants(channelID)
		// Kullanıcı zaten bu kanalda ise (yeniden bağlanma) sayma
		alreadyIn := false
		for _, p := range participants {
			if p.UserID == userID {
				alreadyIn = true
				break
			}
		}
		if !alreadyIn && len(participants) >= channel.UserLimit {
			return nil, fmt.Errorf("%w: voice channel is full", pkg.ErrBadRequest)
		}
	}

	// 7. LiveKit grant'larını permission'lara göre belirle
	canPublish := effectivePerms.Has(models.PermSpeak)
	canSubscribe := true
	canPublishData := true

	// 8. LiveKit AccessToken oluştur
	//
	// auth.NewAccessToken: LiveKit'in JWT builder'ı.
	// API key + secret ile imzalanır, client bununla LiveKit'e bağlanır.
	// LiveKit sunucusu token'ı doğrular ve grant'lara göre izin verir.
	at := auth.NewAccessToken(apiKey, apiSecret)

	// Room name = "{serverID}:{channelID}" — farklı sunuculardaki aynı
	// channel_id'li kanallar LiveKit'te çakışmasın.
	roomName := channel.ServerID + ":" + channelID

	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           roomName,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublishData,
	}

	// LiveKit participant.name — UI'da gösterilecek isim.
	// display_name varsa onu kullan, yoksa username'e düş.
	participantName := username
	if displayName != "" {
		participantName = displayName
	}

	at.AddGrant(grant).
		SetIdentity(userID).
		SetName(participantName).
		SetValidFor(24 * time.Hour) // Uzun validite — LiveKit disconnect'i kendisi yönetir

	token, err := at.ToJWT()
	if err != nil {
		return nil, fmt.Errorf("failed to generate livekit token: %w", err)
	}

	return &models.VoiceTokenResponse{
		Token:     token,
		URL:       lkInstance.URL,
		ChannelID: channelID,
	}, nil
}

// ─── Channel Join/Leave ───

func (s *voiceService) JoinChannel(userID, username, displayName, avatarURL, channelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Kullanıcı zaten başka bir kanalda ise önce çıkar
	if existing, ok := s.states[userID]; ok {
		oldChannelID := existing.ChannelID
		delete(s.states, userID)

		// Eski kanaldan ayrılma broadcast'i
		s.hub.BroadcastToAll(ws.Event{
			Op: ws.OpVoiceStateUpdate,
			Data: ws.VoiceStateUpdateBroadcast{
				UserID:           userID,
				ChannelID:        oldChannelID,
				Username:         username,
				DisplayName:      displayName,
				AvatarURL:        avatarURL,
				IsServerMuted:    existing.IsServerMuted,
				IsServerDeafened: existing.IsServerDeafened,
				Action:           "leave",
			},
		})
	}

	// Yeni kanala katıl
	s.states[userID] = &models.VoiceState{
		UserID:      userID,
		ChannelID:   channelID,
		Username:    username,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
	}

	// Katılma broadcast'i
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      userID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Action:      "join",
		},
	})
	// Not: Yeni katılımda IsServerMuted/IsServerDeafened false (zero value) —
	// struct'ın default'u zaten false, bu yüzden explicit set gerekmez.

	log.Printf("[voice] user %s joined channel %s", userID, channelID)
	return nil
}

func (s *voiceService) LeaveChannel(userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[userID]
	if !ok {
		return nil // Kanalda değil — hata değil, sessizce geç
	}

	channelID := state.ChannelID
	username := state.Username
	displayName := state.DisplayName
	avatarURL := state.AvatarURL
	delete(s.states, userID)

	// Ayrılma broadcast'i — server mute/deafen state'ini de taşır,
	// frontend'in sidebar ikonlarını doğru kaldırması için.
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      userID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Action:      "leave",
		},
	})

	log.Printf("[voice] user %s left channel %s", userID, channelID)
	return nil
}

// ─── State Update ───

func (s *voiceService) UpdateState(userID string, isMuted, isDeafened, isStreaming *bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[userID]
	if !ok {
		return nil // Kanalda değil — sessizce geç
	}

	// Screen share limit kontrolü — maxScreenShares > 0 ise aktif
	if maxScreenShares > 0 && isStreaming != nil && *isStreaming {
		count := 0
		for _, st := range s.states {
			if st.ChannelID == state.ChannelID && st.IsStreaming && st.UserID != userID {
				count++
			}
		}
		if count >= maxScreenShares {
			return fmt.Errorf("%w: maximum screen shares reached", pkg.ErrBadRequest)
		}
	}

	// State güncelle
	if isMuted != nil {
		state.IsMuted = *isMuted
	}
	if isDeafened != nil {
		state.IsDeafened = *isDeafened
	}
	if isStreaming != nil {
		state.IsStreaming = *isStreaming
	}

	// Güncelleme broadcast'i — tüm state alanlarını taşır (server mute/deafen dahil).
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        state.ChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsMuted:          state.IsMuted,
			IsDeafened:       state.IsDeafened,
			IsStreaming:      state.IsStreaming,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "update",
		},
	})

	return nil
}

// ─── Query Methods ───

func (s *voiceService) GetChannelParticipants(channelID string) []models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var participants []models.VoiceState
	for _, state := range s.states {
		if state.ChannelID == channelID {
			participants = append(participants, *state)
		}
	}
	return participants
}

func (s *voiceService) GetUserVoiceState(userID string) *models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if state, ok := s.states[userID]; ok {
		copy := *state
		return &copy
	}
	return nil
}

func (s *voiceService) GetAllVoiceStates() []models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	states := make([]models.VoiceState, 0, len(s.states))
	for _, state := range s.states {
		states = append(states, *state)
	}
	return states
}

func (s *voiceService) DisconnectUser(userID string) {
	// LeaveChannel zaten lock alıyor, bu wrapper sadece error'ı yoksayar
	_ = s.LeaveChannel(userID)
}

func (s *voiceService) GetStreamCount(channelID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := 0
	for _, state := range s.states {
		if state.ChannelID == channelID && state.IsStreaming {
			count++
		}
	}
	return count
}

// ─── Admin State Update ───

// AdminUpdateState, yetkili bir kullanıcının başka bir kullanıcıyı sunucu genelinde
// susturma (server mute) veya sağırlaştırma (server deafen) yapmasını sağlar.
//
// Permission kontrolü:
// - isServerMuted değiştiriliyorsa → PermMuteMembers gerekli
// - isServerDeafened değiştiriliyorsa → PermDeafenMembers gerekli
// Admin yetkisi (PermAdmin) her iki kontrolü de bypass eder (Permission.Has() içindeki check).
//
// Partial update: isServerMuted veya isServerDeafened nil ise o alan değiştirilmez.
func (s *voiceService) AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error {
	// 1. Hedef kullanıcı ses kanalında mı?
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[targetUserID]
	if !ok {
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	// 2. Granüler yetki kontrolü — hedef kullanıcının bulunduğu kanalda
	//    effective permission'ları hesapla (rol + kanal override).
	//    PermAdmin yetkisi her şeyi bypass eder (models.Permission.Has).
	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, adminUserID, state.ChannelID)
	if err != nil {
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}

	// isServerMuted değiştiriliyorsa PermMuteMembers gerekli
	if isServerMuted != nil && !effectivePerms.Has(models.PermMuteMembers) {
		return fmt.Errorf("%w: mute members permission required", pkg.ErrForbidden)
	}
	// isServerDeafened değiştiriliyorsa PermDeafenMembers gerekli
	if isServerDeafened != nil && !effectivePerms.Has(models.PermDeafenMembers) {
		return fmt.Errorf("%w: deafen members permission required", pkg.ErrForbidden)
	}

	// 3. State güncelle (partial update — nil alanlar dokunulmaz)
	if isServerMuted != nil {
		state.IsServerMuted = *isServerMuted
	}
	if isServerDeafened != nil {
		state.IsServerDeafened = *isServerDeafened
	}

	// 4. Tüm client'lara broadcast et
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        state.ChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsMuted:          state.IsMuted,
			IsDeafened:       state.IsDeafened,
			IsStreaming:      state.IsStreaming,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "update",
		},
	})

	log.Printf("[voice] admin %s updated server state for user %s (muted=%v, deafened=%v)",
		adminUserID, targetUserID, state.IsServerMuted, state.IsServerDeafened)
	return nil
}

// ─── Move & Disconnect ───

// MoveUser, bir kullanıcıyı mevcut ses kanalından başka bir ses kanalına taşır.
//
// Permission kontrolü:
// Mover'ın KAYNAK kanalda ve HEDEF kanalda PermMoveMembers yetkisi olmalıdır.
// Admin yetkisi her ikisini de bypass eder.
//
// İşlem sırası:
// 1. Hedef kullanıcı voice'ta mı?
// 2. Hedef kanal voice tipinde mi?
// 3. Kaynak + hedef kanalda PermMoveMembers?
// 4. State güncelle → leave(eski) + join(yeni) broadcast
// 5. Hedef kullanıcıya voice_force_move gönder
func (s *voiceService) MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error {
	// 1. Hedef kanal voice tipinde mi?
	channel, err := s.channelGetter.GetByID(ctx, targetChannelID)
	if err != nil {
		return fmt.Errorf("%w: target channel not found", pkg.ErrNotFound)
	}
	if channel.Type != models.ChannelTypeVoice {
		return fmt.Errorf("%w: target is not a voice channel", pkg.ErrBadRequest)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// 2. Hedef kullanıcı voice'ta mı?
	state, ok := s.states[targetUserID]
	if !ok {
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	sourceChannelID := state.ChannelID

	// Aynı kanala taşımaya gerek yok
	if sourceChannelID == targetChannelID {
		return fmt.Errorf("%w: user is already in that channel", pkg.ErrBadRequest)
	}

	// 3. Mover'ın kaynak kanalda PermMoveMembers yetkisi var mı?
	sourcePerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, sourceChannelID)
	if err != nil {
		return fmt.Errorf("failed to resolve source channel permissions: %w", err)
	}
	if !sourcePerms.Has(models.PermMoveMembers) {
		return fmt.Errorf("%w: move members permission required in source channel", pkg.ErrForbidden)
	}

	// 4. Mover'ın hedef kanalda PermMoveMembers yetkisi var mı?
	targetPerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, targetChannelID)
	if err != nil {
		return fmt.Errorf("failed to resolve target channel permissions: %w", err)
	}
	if !targetPerms.Has(models.PermMoveMembers) {
		return fmt.Errorf("%w: move members permission required in target channel", pkg.ErrForbidden)
	}

	// 5. State güncelle — eski kanaldan çık, yeni kanala geç
	state.ChannelID = targetChannelID

	// 6. Broadcast: leave(eski kanal) + join(yeni kanal)
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        sourceChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "leave",
		},
	})
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        targetChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsMuted:          state.IsMuted,
			IsDeafened:       state.IsDeafened,
			IsStreaming:      state.IsStreaming,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "join",
		},
	})

	// 7. Hedef kullanıcıya voice_force_move gönder — client LiveKit room'u değiştirecek
	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op:   ws.OpVoiceForceMove,
		Data: ws.VoiceForceMoveData{ChannelID: targetChannelID},
	})

	log.Printf("[voice] user %s moved user %s from channel %s to %s",
		moverUserID, targetUserID, sourceChannelID, targetChannelID)
	return nil
}

// AdminDisconnectUser, bir kullanıcıyı ses kanalından atar (force disconnect).
//
// Permission kontrolü:
// Atan kişinin hedef kullanıcının bulunduğu kanalda PermMoveMembers yetkisi olmalıdır.
// Discord'da da Disconnect = Move Members yetkisine bağlıdır.
func (s *voiceService) AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 1. Hedef kullanıcı voice'ta mı?
	state, ok := s.states[targetUserID]
	if !ok {
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	// 2. Disconnecter'ın o kanalda PermMoveMembers yetkisi var mı?
	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, disconnecterUserID, state.ChannelID)
	if err != nil {
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}
	if !effectivePerms.Has(models.PermMoveMembers) {
		return fmt.Errorf("%w: move members permission required", pkg.ErrForbidden)
	}

	// 3. State temizle
	channelID := state.ChannelID
	username := state.Username
	displayName := state.DisplayName
	avatarURL := state.AvatarURL
	delete(s.states, targetUserID)

	// 4. Broadcast: leave
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      targetUserID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Action:      "leave",
		},
	})

	// 5. Hedef kullanıcıya voice_force_disconnect gönder — client LiveKit'ten çıksın
	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op: ws.OpVoiceForceDisconnect,
	})

	log.Printf("[voice] admin %s disconnected user %s from channel %s",
		disconnecterUserID, targetUserID, channelID)
	return nil
}
