// Package services, voice (ses) iş mantığını yönetir.
//
// VoiceService sorumluluları:
// 1. LiveKit token generate etme (ses kanalına katılım için)
// 2. In-memory voice state yönetimi (kim hangi kanalda, mute/deafen/stream)
// 3. State değişikliklerini WS Hub üzerinden broadcast etme
//
// Neden in-memory (DB değil)?
// Voice state geçicidir — sunucu yeniden başlatıldığında tüm WS
// bağlantıları da düşer. DB'ye yazmak gereksiz I/O olur.
// sync.RWMutex ile concurrent erişim güvenliği sağlanır.
//
// Token generation nedir?
// LiveKit'e bağlanmak için client'ın bir JWT token'a ihtiyacı var.
// Bu token sunucu tarafında oluşturulur ve şunları içerir:
// - Hangi odaya (channel) katılabilir
// - Ses yayını yapabilir mi (PermSpeak)
// - Ekran paylaşabilir mi (PermStream)
// Token, LiveKit'in API key/secret çiftiyle imzalanır.
package services

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
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

// ─── VoiceService Interface ───

// VoiceService, ses kanalı operasyonları için iş mantığı interface'i.
type VoiceService interface {
	// GenerateToken, LiveKit JWT oluşturur. Permission kontrolü içerir.
	GenerateToken(ctx context.Context, userID, username, channelID string) (*models.VoiceTokenResponse, error)

	// JoinChannel, kullanıcıyı ses kanalına kaydeder ve broadcast eder.
	// Kullanıcı başka bir kanalda ise önce oradan çıkarılır.
	JoinChannel(userID, username, avatarURL, channelID string) error

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
	channelGetter ChannelGetter
	permResolver  ChannelPermResolver // Kanal bazlı permission override çözümleme (rol + channel override)
	hub           ws.EventPublisher
	livekitCfg    config.LiveKitConfig
}

// maxScreenShares, bir ses kanalında aynı anda izin verilen
// maksimum ekran paylaşımı sayısı (CLAUDE.md kuralı).
const maxScreenShares = 2

// NewVoiceService, yeni bir VoiceService oluşturur.
// Constructor injection pattern: tüm dependency'ler parametre olarak alınır.
// permResolver: Kanal bazlı permission override çözümleme — ConnectVoice, Speak, Stream
// kontrolünde rol + kanal override birlikte hesaplanır.
func NewVoiceService(
	channelGetter ChannelGetter,
	permResolver ChannelPermResolver,
	hub ws.EventPublisher,
	livekitCfg config.LiveKitConfig,
) VoiceService {
	return &voiceService{
		states:        make(map[string]*models.VoiceState),
		channelGetter: channelGetter,
		permResolver:  permResolver,
		hub:           hub,
		livekitCfg:    livekitCfg,
	}
}

// ─── Token Generation ───

func (s *voiceService) GenerateToken(ctx context.Context, userID, username, channelID string) (*models.VoiceTokenResponse, error) {
	// 1. Kanal var mı ve voice tipinde mi?
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.Type != models.ChannelTypeVoice {
		return nil, fmt.Errorf("%w: not a voice channel", pkg.ErrBadRequest)
	}

	// 2. Kanal bazlı effective permissions hesapla (override'lar dahil)
	//
	// ResolveChannelPermissions, Discord algoritmasını uygular:
	// base (tüm rollerin OR'u) + channel override'lar (allow/deny).
	// Admin yetkisi tüm override'ları bypass eder.
	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}

	// 3. PermConnectVoice kontrolü
	if !effectivePerms.Has(models.PermConnectVoice) {
		return nil, fmt.Errorf("%w: missing voice connect permission", pkg.ErrForbidden)
	}

	// 4. UserLimit kontrolü (0 = sınırsız)
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

	// 5. LiveKit grant'larını permission'lara göre belirle
	canPublish := effectivePerms.Has(models.PermSpeak)
	canSubscribe := true
	canPublishData := true

	// 6. LiveKit AccessToken oluştur
	//
	// auth.NewAccessToken: LiveKit'in JWT builder'ı.
	// API key + secret ile imzalanır, client bununla LiveKit'e bağlanır.
	// LiveKit sunucusu token'ı doğrular ve grant'lara göre izin verir.
	at := auth.NewAccessToken(s.livekitCfg.APIKey, s.livekitCfg.APISecret)

	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           channelID, // LiveKit room name = channel ID
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublishData,
	}

	at.AddGrant(grant).
		SetIdentity(userID).
		SetName(username).
		SetValidFor(24 * time.Hour) // Uzun validite — LiveKit disconnect'i kendisi yönetir

	token, err := at.ToJWT()
	if err != nil {
		return nil, fmt.Errorf("failed to generate livekit token: %w", err)
	}

	return &models.VoiceTokenResponse{
		Token:     token,
		URL:       s.livekitCfg.URL,
		ChannelID: channelID,
	}, nil
}

// ─── Channel Join/Leave ───

func (s *voiceService) JoinChannel(userID, username, avatarURL, channelID string) error {
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
				UserID:    userID,
				ChannelID: oldChannelID,
				Username:  username,
				AvatarURL: avatarURL,
				Action:    "leave",
			},
		})
	}

	// Yeni kanala katıl
	s.states[userID] = &models.VoiceState{
		UserID:    userID,
		ChannelID: channelID,
		Username:  username,
		AvatarURL: avatarURL,
	}

	// Katılma broadcast'i
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:    userID,
			ChannelID: channelID,
			Username:  username,
			AvatarURL: avatarURL,
			Action:    "join",
		},
	})

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
	avatarURL := state.AvatarURL
	delete(s.states, userID)

	// Ayrılma broadcast'i
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:    userID,
			ChannelID: channelID,
			Username:  username,
			AvatarURL: avatarURL,
			Action:    "leave",
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

	// Screen share limit kontrolü
	if isStreaming != nil && *isStreaming {
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

	// Güncelleme broadcast'i
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      state.UserID,
			ChannelID:   state.ChannelID,
			Username:    state.Username,
			AvatarURL:   state.AvatarURL,
			IsMuted:     state.IsMuted,
			IsDeafened:  state.IsDeafened,
			IsStreaming: state.IsStreaming,
			Action:      "update",
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
