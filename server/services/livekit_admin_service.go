// Package services — LiveKitAdminService, platform admin tarafından LiveKit instance yönetimi.
//
// Bu service platform-managed LiveKit instance'ların CRUD işlemlerini yönetir.
// Self-hosted instance'lar bu service'in kapsamı dışındadır — onlar ServerService üzerinden yönetilir.
//
// Credential'lar AES-256-GCM ile şifrelenir (pkg/crypto).
// Admin'e dönen view'larda credential'lar ASLA yer almaz.
package services

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/pkg/promparse"
	"github.com/akinalp/mqvi/repository"
)

// ActiveVoiceProvider — admin service'in in-memory voice state'e erişmesi için ISP interface.
// VoiceService bu interface'i Go duck typing ile otomatik karşılar.
type ActiveVoiceProvider interface {
	GetAllVoiceStates() []models.VoiceState
}

// LiveKitAdminService, platform admin'in LiveKit instance yönetimi için interface.
type LiveKitAdminService interface {
	// ListInstances, tüm platform-managed LiveKit instance'larını döner.
	// Credential'lar dönen view'da yer almaz.
	ListInstances(ctx context.Context) ([]models.LiveKitInstanceAdminView, error)

	// GetInstance, tek bir LiveKit instance'ı döner.
	GetInstance(ctx context.Context, instanceID string) (*models.LiveKitInstanceAdminView, error)

	// CreateInstance, yeni bir platform-managed LiveKit instance oluşturur.
	// Credential'lar AES-256-GCM ile şifrelenerek DB'ye yazılır.
	CreateInstance(ctx context.Context, req *models.CreateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error)

	// UpdateInstance, mevcut bir instance'ı günceller.
	// Optional alanlar — sadece gönderilen alanlar güncellenir.
	// Credential boş bırakılırsa mevcut değerler korunur.
	UpdateInstance(ctx context.Context, instanceID string, req *models.UpdateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error)

	// DeleteInstance, bir instance'ı siler.
	// Bağlı sunucular varsa targetInstanceID'ye migrate eder.
	// targetInstanceID boş ve serverCount > 0 ise hata döner.
	DeleteInstance(ctx context.Context, instanceID, targetInstanceID string) error

	// ListServers, platformdaki tüm sunucuları istatistikleriyle döner.
	// Admin panelde sunucu listesi için kullanılır.
	ListServers(ctx context.Context) ([]models.AdminServerListItem, error)

	// MigrateServerInstance, tek bir sunucunun LiveKit instance'ını değiştirir.
	// Validation: hedef instance platform-managed olmalı, kapasitesi dolmamış olmalı.
	// Self-hosted sunucular taşınamaz.
	MigrateServerInstance(ctx context.Context, serverID, newInstanceID string) error

	// ListUsers, platformdaki tüm kullanıcıları istatistikleriyle döner.
	// Admin panelde kullanıcı listesi için kullanılır.
	ListUsers(ctx context.Context) ([]models.AdminUserListItem, error)

	// GetInstanceMetrics, bir LiveKit instance'ın Prometheus /metrics endpoint'inden
	// anlık kaynak kullanım metriklerini çeker ve parse eder.
	// Instance URL'si DB'den alınır, credential'lar decrypt edilir (gerekirse).
	// /metrics erişilemezse Available=false döner, hata dönmez.
	GetInstanceMetrics(ctx context.Context, instanceID string) (*models.LiveKitInstanceMetrics, error)
}

type livekitAdminService struct {
	livekitRepo   repository.LiveKitRepository
	serverRepo    repository.ServerRepository
	userRepo      repository.UserRepository
	channelRepo   repository.ChannelRepository
	voiceProvider ActiveVoiceProvider
	encryptionKey []byte
	httpClient    *http.Client // Prometheus /metrics fetch için
}

// NewLiveKitAdminService, constructor — interface döner.
// serverRepo: admin sunucu listesi (ListAllWithStats) için gerekli.
// userRepo: admin kullanıcı listesi (ListAllUsersWithStats) için gerekli.
// channelRepo: aktif ses kullanıcılarının kanal → sunucu lookup'ı için gerekli.
// voiceProvider: in-memory voice state'e erişim (aktif ses kullanıcıları last_activity hesabında kullanılır).
func NewLiveKitAdminService(
	livekitRepo repository.LiveKitRepository,
	serverRepo repository.ServerRepository,
	userRepo repository.UserRepository,
	channelRepo repository.ChannelRepository,
	voiceProvider ActiveVoiceProvider,
	encryptionKey []byte,
) LiveKitAdminService {
	return &livekitAdminService{
		livekitRepo:   livekitRepo,
		serverRepo:    serverRepo,
		userRepo:      userRepo,
		channelRepo:   channelRepo,
		voiceProvider: voiceProvider,
		encryptionKey: encryptionKey,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
			// Self-signed sertifika kullanan LiveKit instance'lar için TLS skip.
			// Bu sadece backend → LiveKit server arası internal trafikte kullanılır.
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
	}
}

func (s *livekitAdminService) ListInstances(ctx context.Context) ([]models.LiveKitInstanceAdminView, error) {
	instances, err := s.livekitRepo.ListPlatformInstances(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list platform instances: %w", err)
	}

	views := make([]models.LiveKitInstanceAdminView, len(instances))
	for i, inst := range instances {
		views[i] = toAdminView(&inst)
	}

	return views, nil
}

func (s *livekitAdminService) GetInstance(ctx context.Context, instanceID string) (*models.LiveKitInstanceAdminView, error) {
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	view := toAdminView(inst)
	return &view, nil
}

func (s *livekitAdminService) CreateInstance(ctx context.Context, req *models.CreateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Credential'ları şifrele
	encKey, err := crypto.Encrypt(req.APIKey, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt api key: %w", err)
	}
	encSecret, err := crypto.Encrypt(req.APISecret, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt api secret: %w", err)
	}

	instance := &models.LiveKitInstance{
		URL:               req.URL,
		APIKey:            encKey,
		APISecret:         encSecret,
		IsPlatformManaged: true,
		ServerCount:       0,
		MaxServers:        req.MaxServers,
	}

	if err := s.livekitRepo.Create(ctx, instance); err != nil {
		return nil, fmt.Errorf("failed to create livekit instance: %w", err)
	}

	view := toAdminView(instance)
	return &view, nil
}

func (s *livekitAdminService) UpdateInstance(ctx context.Context, instanceID string, req *models.UpdateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Mevcut instance'ı getir
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	// Sadece platform-managed instance'lar güncellenebilir
	if !inst.IsPlatformManaged {
		return nil, fmt.Errorf("%w: only platform-managed instances can be updated via admin API", pkg.ErrForbidden)
	}

	// Optional alanları güncelle
	if req.URL != nil {
		inst.URL = *req.URL
	}
	if req.APIKey != nil {
		encKey, encErr := crypto.Encrypt(*req.APIKey, s.encryptionKey)
		if encErr != nil {
			return nil, fmt.Errorf("failed to encrypt api key: %w", encErr)
		}
		inst.APIKey = encKey
	}
	if req.APISecret != nil {
		encSecret, encErr := crypto.Encrypt(*req.APISecret, s.encryptionKey)
		if encErr != nil {
			return nil, fmt.Errorf("failed to encrypt api secret: %w", encErr)
		}
		inst.APISecret = encSecret
	}
	if req.MaxServers != nil {
		inst.MaxServers = *req.MaxServers
	}

	if err := s.livekitRepo.Update(ctx, inst); err != nil {
		return nil, fmt.Errorf("failed to update livekit instance: %w", err)
	}

	view := toAdminView(inst)
	return &view, nil
}

func (s *livekitAdminService) DeleteInstance(ctx context.Context, instanceID, targetInstanceID string) error {
	// Silinecek instance'ı getir
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return err
	}

	// Sadece platform-managed instance'lar silinebilir
	if !inst.IsPlatformManaged {
		return fmt.Errorf("%w: only platform-managed instances can be deleted via admin API", pkg.ErrForbidden)
	}

	// Bağlı sunucular varsa migration gerekli
	if inst.ServerCount > 0 {
		if targetInstanceID == "" {
			return fmt.Errorf("%w: instance has %d server(s), specify migrate_to target", pkg.ErrBadRequest, inst.ServerCount)
		}

		// Kendine migrate etme
		if targetInstanceID == instanceID {
			return fmt.Errorf("%w: cannot migrate to the same instance", pkg.ErrBadRequest)
		}

		// Hedef instance'ın varlığını kontrol et
		target, targetErr := s.livekitRepo.GetByID(ctx, targetInstanceID)
		if targetErr != nil {
			return fmt.Errorf("migration target not found: %w", targetErr)
		}

		// Hedef platform-managed olmalı
		if !target.IsPlatformManaged {
			return fmt.Errorf("%w: migration target must be a platform-managed instance", pkg.ErrBadRequest)
		}

		// Sunucuları taşı
		_, migrateErr := s.livekitRepo.MigrateServers(ctx, instanceID, targetInstanceID)
		if migrateErr != nil {
			return fmt.Errorf("failed to migrate servers: %w", migrateErr)
		}
	}

	// Instance'ı sil
	if err := s.livekitRepo.Delete(ctx, instanceID); err != nil {
		return fmt.Errorf("failed to delete livekit instance: %w", err)
	}

	return nil
}

func (s *livekitAdminService) ListServers(ctx context.Context) ([]models.AdminServerListItem, error) {
	servers, err := s.serverRepo.ListAllWithStats(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list all servers: %w", err)
	}

	// In-memory voice state'ten aktif ses kullanıcılarını al.
	// Şu anda ses kanalında olan kullanıcılar varsa, o sunucunun last_activity'sini "now" yap.
	// DB sadece JOIN anını kaydeder — devam eden voice session'ı göstermek için
	// in-memory state ile cross-reference gerekli.
	activeServerIDs := s.getActiveVoiceServerIDs(ctx)
	if len(activeServerIDs) > 0 {
		now := time.Now().UTC().Format("2006-01-02 15:04:05")
		for i := range servers {
			if activeServerIDs[servers[i].ID] {
				servers[i].LastActivity = &now
			}
		}
	}

	return servers, nil
}

func (s *livekitAdminService) MigrateServerInstance(ctx context.Context, serverID, newInstanceID string) error {
	// 1. Sunucunun varlığını kontrol et
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	// 2. Sunucunun mevcut instance'ı platform-managed olmalı (self-hosted taşınamaz)
	if server.LiveKitInstanceID == nil || *server.LiveKitInstanceID == "" {
		return fmt.Errorf("%w: server has no LiveKit instance assigned", pkg.ErrBadRequest)
	}

	currentInstance, err := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
	if err != nil {
		return fmt.Errorf("failed to get current instance: %w", err)
	}

	if !currentInstance.IsPlatformManaged {
		return fmt.Errorf("%w: self-hosted servers cannot be migrated via admin API", pkg.ErrForbidden)
	}

	// 3. Aynı instance'a taşıma yapma
	if *server.LiveKitInstanceID == newInstanceID {
		return fmt.Errorf("%w: server is already on this instance", pkg.ErrBadRequest)
	}

	// 4. Hedef instance var mı, platform-managed mi
	targetInstance, err := s.livekitRepo.GetByID(ctx, newInstanceID)
	if err != nil {
		return fmt.Errorf("target instance not found: %w", err)
	}

	if !targetInstance.IsPlatformManaged {
		return fmt.Errorf("%w: target must be a platform-managed instance", pkg.ErrBadRequest)
	}

	// 5. Hedef kapasite dolmamış mı
	if targetInstance.MaxServers > 0 && targetInstance.ServerCount >= targetInstance.MaxServers {
		return fmt.Errorf("%w: target instance is at capacity (%d/%d)", pkg.ErrBadRequest,
			targetInstance.ServerCount, targetInstance.MaxServers)
	}

	// 6. Transaction ile taşı
	if err := s.livekitRepo.MigrateOneServer(ctx, serverID, newInstanceID); err != nil {
		return fmt.Errorf("failed to migrate server instance: %w", err)
	}

	return nil
}

func (s *livekitAdminService) ListUsers(ctx context.Context) ([]models.AdminUserListItem, error) {
	users, err := s.userRepo.ListAllUsersWithStats(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list all users: %w", err)
	}

	// In-memory voice state'ten aktif ses kullanıcılarını al.
	// Ses kanalında olan kullanıcıların last_activity'sini "now" yap.
	activeUserIDs := s.getActiveVoiceUserIDs()
	if len(activeUserIDs) > 0 {
		now := time.Now().UTC().Format("2006-01-02 15:04:05")
		for i := range users {
			if activeUserIDs[users[i].ID] {
				users[i].LastActivity = &now
			}
		}
	}

	return users, nil
}

// getActiveVoiceServerIDs, in-memory voice state'ten hangi sunucularda aktif ses
// kullanıcısı olduğunu hesaplar. VoiceState sadece channelID tutar — channel → server
// lookup'ı için channelRepo kullanılır.
func (s *livekitAdminService) getActiveVoiceServerIDs(ctx context.Context) map[string]bool {
	states := s.voiceProvider.GetAllVoiceStates()
	if len(states) == 0 {
		return nil
	}

	// Unique channel ID'leri topla (aynı kanalda birden fazla kullanıcı olabilir)
	channelIDs := make(map[string]struct{})
	for _, st := range states {
		channelIDs[st.ChannelID] = struct{}{}
	}

	// Her channel'dan server ID'yi bul
	serverIDs := make(map[string]bool)
	for chID := range channelIDs {
		ch, err := s.channelRepo.GetByID(ctx, chID)
		if err != nil {
			continue // kanal silinmiş olabilir, skip
		}
		serverIDs[ch.ServerID] = true
	}

	return serverIDs
}

// getActiveVoiceUserIDs, in-memory voice state'ten şu anda ses kanalında olan
// kullanıcı ID'lerini döner.
func (s *livekitAdminService) getActiveVoiceUserIDs() map[string]bool {
	states := s.voiceProvider.GetAllVoiceStates()
	if len(states) == 0 {
		return nil
	}

	userIDs := make(map[string]bool, len(states))
	for _, st := range states {
		userIDs[st.UserID] = true
	}
	return userIDs
}

func (s *livekitAdminService) GetInstanceMetrics(ctx context.Context, instanceID string) (*models.LiveKitInstanceMetrics, error) {
	// 1. Instance'ı DB'den getir
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	// 2. URL'yi /metrics endpoint'ine çevir
	// wss://livekit.example.com → https://livekit.example.com/metrics
	// ws://localhost:7880 → http://localhost:7880/metrics
	metricsURL := LiveKitURLToMetrics(inst.URL)

	// 3. /metrics endpoint'ini çağır
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, metricsURL, nil)
	if err != nil {
		// URL parse hatası — available=false dön
		return &models.LiveKitInstanceMetrics{
			FetchedAt: time.Now().UTC(),
			Available: false,
		}, nil
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		// Bağlantı hatası — available=false dön, hata dönme
		return &models.LiveKitInstanceMetrics{
			FetchedAt: time.Now().UTC(),
			Available: false,
		}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &models.LiveKitInstanceMetrics{
			FetchedAt: time.Now().UTC(),
			Available: false,
		}, nil
	}

	// 4. Response body'yi oku (max 5MB — Prometheus metrics genelde küçüktür)
	body, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
	if err != nil {
		return &models.LiveKitInstanceMetrics{
			FetchedAt: time.Now().UTC(),
			Available: false,
		}, nil
	}

	// 5. Prometheus formatını parse et
	m := promparse.Parse(string(body))

	// LiveKit metric isimleri (kaynak: github.com/livekit/livekit/pkg/telemetry/prometheus):
	//   rooms.go:   livekit_room_total, livekit_participant_total,
	//               livekit_track_published_total{kind}, livekit_track_subscribed_total{kind}
	//   packets.go: livekit_packet_bytes{direction}, livekit_packet_total{direction}
	//               livekit_nack_total
	// Go standard: process_resident_memory_bytes, go_goroutines
	return &models.LiveKitInstanceMetrics{
		Goroutines:          m.Int("go_goroutines"),
		MemoryUsed:          m.Uint64("process_resident_memory_bytes"),
		RoomCount:           m.Int("livekit_room_total"),
		ParticipantCount:    m.Int("livekit_participant_total"),
		TrackPublishCount:   m.SumInt("livekit_track_published_total"),   // sum audio+video
		TrackSubscribeCount: m.SumInt("livekit_track_subscribed_total"),  // sum audio+video
		BytesIn:             m.Uint64WithLabel("livekit_packet_bytes", "direction", "incoming"),
		BytesOut:            m.Uint64WithLabel("livekit_packet_bytes", "direction", "outgoing"),
		PacketsIn:           m.Uint64WithLabel("livekit_packet_total", "direction", "incoming"),
		PacketsOut:          m.Uint64WithLabel("livekit_packet_total", "direction", "outgoing"),
		NackTotal:           m.SumUint64("livekit_nack_total"),
		FetchedAt:           time.Now().UTC(),
		Available:           true,
	}, nil
}

// LiveKitURLToMetrics, LiveKit WebSocket URL'sini Prometheus /metrics HTTP URL'sine
// dönüştürür. MetricsCollector da bu fonksiyonu kullanır.
//
//	wss://livekit.example.com → https://livekit.example.com/metrics
//	ws://localhost:7880 → http://localhost:7880/metrics
//	https://livekit.example.com → https://livekit.example.com/metrics
func LiveKitURLToMetrics(rawURL string) string {
	u := rawURL

	// Protokol dönüşümü: wss→https, ws→http
	if strings.HasPrefix(u, "wss://") {
		u = "https://" + strings.TrimPrefix(u, "wss://")
	} else if strings.HasPrefix(u, "ws://") {
		u = "http://" + strings.TrimPrefix(u, "ws://")
	}

	// Trailing slash temizle
	u = strings.TrimRight(u, "/")

	return u + "/metrics"
}

// toAdminView, LiveKitInstance'ı credential'sız admin view'a dönüştürür.
func toAdminView(inst *models.LiveKitInstance) models.LiveKitInstanceAdminView {
	return models.LiveKitInstanceAdminView{
		ID:                inst.ID,
		URL:               inst.URL,
		IsPlatformManaged: inst.IsPlatformManaged,
		ServerCount:       inst.ServerCount,
		MaxServers:        inst.MaxServers,
		CreatedAt:         inst.CreatedAt,
	}
}
