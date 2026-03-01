// Package services — ChannelPermissionService: kanal bazlı permission override iş mantığı.
//
// Discord'taki gibi, belirli bir kanaldaki rollere özel izin/engelleme tanımlar.
// Her (channel_id, role_id) çifti için allow/deny bit'leri saklanır.
//
// Permission resolution algoritması (Discord):
//
//	base = tüm rollerin permission'larının OR'u
//	channelAllow = kullanıcının rollerine ait override allow'ların OR'u
//	channelDeny  = kullanıcının rollerine ait override deny'ların OR'u
//	effective    = (base & ~channelDeny) | channelAllow
//
// Admin yetkisi tüm override'ları bypass eder.
package services

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/cache"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// Permission cache TTL ve cleanup ayarları.
//
// 30 saniyelik TTL: Permission override'lar nadir değişir,
// ama değiştiğinde cache invalidation da yapıldığı için TTL sadece
// "en kötü durumda ne kadar stale kalabilir" sorusunu yanıtlar.
//
// Cache key formatı: "userID:channelID" — her kullanıcı+kanal çifti
// ayrı bir entry olarak saklanır.
const (
	permCacheTTL     = 30 * time.Second
	permCacheCleanup = 5 * time.Minute
)

// ChannelPermResolver, kanal bazlı effective permission hesaplayan ISP interface.
//
// Interface Segregation Principle: MessageService ve VoiceService sadece
// permission resolution'a ihtiyaç duyar, override CRUD'a değil.
// Bu minimal interface sayesinde service'ler birbirine sıkı bağımlı olmaz.
//
// ChannelPermissionService bu interface'i otomatik karşılar (Go duck typing).
type ChannelPermResolver interface {
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
}

// ChannelPermissionService, kanal bazlı permission override yönetimi interface'i.
type ChannelPermissionService interface {
	// GetOverrides, bir kanaldaki tüm permission override'ları döner.
	// Admin panelinde kullanılır — "bu kanalda hangi roller için override var?"
	GetOverrides(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error)

	// SetOverride, bir kanal-rol çifti için override oluşturur veya günceller.
	// allow=0, deny=0 ise override'ı siler (inherit'e döner).
	SetOverride(ctx context.Context, channelID, roleID string, req *models.SetOverrideRequest) error

	// DeleteOverride, bir kanal-rol çifti için override'ı kaldırır.
	DeleteOverride(ctx context.Context, channelID, roleID string) error

	// ResolveChannelPermissions, bir kullanıcının belirli bir kanaldaki effective permission'ını hesaplar.
	//
	// Discord algoritması:
	// 1. Kanalın ait olduğu sunucuyu bul (channel → server_id)
	// 2. Kullanıcının o sunucudaki rollerini al
	// 3. Base permissions = tüm rollerin OR'u
	// 4. Admin varsa → PermAll döner (tüm override'ları bypass)
	// 5. Bu kanal için kullanıcının rollerine ait override'ları al
	// 6. Allow ve Deny bit'lerini OR'la
	// 7. effective = (base & ~deny) | allow
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)

	// BuildVisibilityFilter, kullanıcı bazlı kanal görünürlük filtresi oluşturur.
	// ChannelService tarafından GetAllGrouped'da ViewChannel yetkisi kontrolü için kullanılır.
	// ChannelVisibilityChecker ISP'yi de karşılar (Go duck typing).
	// serverID parametresi ile kullanıcının o sunucudaki rolleri alınır.
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)
}

type channelPermService struct {
	permRepo      repository.ChannelPermissionRepository
	roleRepo      repository.RoleRepository
	channelGetter ChannelGetter // kanal → server_id lookup (ResolveChannelPermissions için)
	hub           ws.Broadcaster

	// permCache: ResolveChannelPermissions sonuçlarını cache'ler.
	//
	// Neden cache? ResolveChannelPermissions her mesaj gönderiminde, ses kanalına
	// bağlanmada vs. çağrılır — 3 DB query (channel lookup + roles + overrides).
	// Cache ile hot path'te DB'ye inmeden bellekten döner.
	//
	// Invalidation: SetOverride/DeleteOverride'da channelID'ye ait TÜM entry'ler silinir.
	// Key format: "userID:channelID"
	permCache *cache.TTLCache[string, models.Permission]
}

// NewChannelPermissionService, ChannelPermissionService implementasyonunu oluşturur.
//
// Dependency'ler:
// - permRepo: kanal permission override CRUD
// - roleRepo: kullanıcının rollerini almak için (ResolveChannelPermissions'da)
// - channelGetter: kanal → server_id lookup (rolları sunucu bazlı çekmek için)
// - hub: override değişikliklerini WS ile broadcast etmek için
func NewChannelPermissionService(
	permRepo repository.ChannelPermissionRepository,
	roleRepo repository.RoleRepository,
	channelGetter ChannelGetter,
	hub ws.Broadcaster,
) ChannelPermissionService {
	return &channelPermService{
		permRepo:      permRepo,
		roleRepo:      roleRepo,
		channelGetter: channelGetter,
		hub:           hub,
		permCache:     cache.New[string, models.Permission](permCacheTTL, permCacheCleanup),
	}
}

func (s *channelPermService) GetOverrides(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error) {
	overrides, err := s.permRepo.GetByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel overrides: %w", err)
	}

	// nil yerine boş slice dön — JSON'da [] olarak serialize olur, null değil
	if overrides == nil {
		overrides = []models.ChannelPermissionOverride{}
	}

	return overrides, nil
}

func (s *channelPermService) SetOverride(ctx context.Context, channelID, roleID string, req *models.SetOverrideRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("invalid override request: %w", err)
	}

	// allow=0, deny=0 → override'ın anlamı yok (inherit ile aynı), sil
	if req.Allow == 0 && req.Deny == 0 {
		// Override yoksa hata dönecek — idempotent olması için hatayı logla ama döndürme
		if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
			log.Printf("[channel-perm] failed to delete override (idempotent, non-fatal) channel=%s role=%s: %v", channelID, roleID, err)
		}

		// Cache invalidation — bu kanaldaki TÜM kullanıcıların cache'i stale oldu
		s.invalidateChannelCache(channelID)

		s.hub.BroadcastToAll(ws.Event{
			Op: ws.OpChannelPermissionDelete,
			Data: map[string]string{
				"channel_id": channelID,
				"role_id":    roleID,
			},
		})

		return nil
	}

	override := &models.ChannelPermissionOverride{
		ChannelID: channelID,
		RoleID:    roleID,
		Allow:     req.Allow,
		Deny:      req.Deny,
	}

	if err := s.permRepo.Set(ctx, override); err != nil {
		return fmt.Errorf("failed to set channel override: %w", err)
	}

	// Cache invalidation — override değişti, bu kanaldaki tüm kullanıcıların sonucu etkilenebilir
	s.invalidateChannelCache(channelID)

	// WS broadcast — tüm client'lar override değişikliğini görsün
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelPermissionUpdate,
		Data: override,
	})

	return nil
}

func (s *channelPermService) DeleteOverride(ctx context.Context, channelID, roleID string) error {
	if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
		return fmt.Errorf("failed to delete channel override: %w", err)
	}

	// Cache invalidation — override kaldırıldı, bu kanaldaki sonuçlar değişir
	s.invalidateChannelCache(channelID)

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpChannelPermissionDelete,
		Data: map[string]string{
			"channel_id": channelID,
			"role_id":    roleID,
		},
	})

	return nil
}

// BuildVisibilityFilter, kullanıcı bazlı kanal görünürlük filtresi oluşturur.
//
// serverID parametresi sayesinde kullanıcının o sunucudaki rollerini alır.
// Tüm kanallardaki ViewChannel override'larını tek sorguda çeker (GetByRoles)
// ve her kanal için effective ViewChannel yetkisini hesaplar.
//
// Sonuç:
// - IsAdmin=true → Admin tüm kanalları görür
// - HasBaseView=true → Base permission'da ViewChannel var, override yoksa görünür
// - HiddenChannels → Override ile ViewChannel kaldırılan kanallar
// - GrantedChannels → Override ile ViewChannel eklenen kanallar (base'de yoksa)
func (s *channelPermService) BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error) {
	// 1. Kullanıcının o sunucudaki rollerini al
	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user roles for visibility filter: %w", err)
	}

	// 2. Base permission = tüm rollerin OR'u
	var base models.Permission
	roleIDs := make([]string, len(roles))
	for i, r := range roles {
		base |= r.Permissions
		roleIDs[i] = r.ID
	}

	// 3. Admin → her şeyi görür, filtreleme gereksiz
	if base.Has(models.PermAdmin) {
		return &ChannelVisibilityFilter{IsAdmin: true}, nil
	}

	hasBaseView := base.Has(models.PermViewChannel)

	// 4. Tüm override'ları tek sorguda çek
	overrides, err := s.permRepo.GetByRoles(ctx, roleIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to get role overrides for visibility filter: %w", err)
	}

	// Override yoksa sadece base'e göre karar ver
	if len(overrides) == 0 {
		return &ChannelVisibilityFilter{
			HasBaseView:     hasBaseView,
			HiddenChannels:  make(map[string]bool),
			GrantedChannels: make(map[string]bool),
		}, nil
	}

	// 5. Override'ları channel_id bazında grupla
	// Her kanal için kullanıcının TÜM rollerinin allow/deny OR'u hesaplanır.
	type channelOverride struct {
		allow models.Permission
		deny  models.Permission
	}
	byChannel := make(map[string]*channelOverride)
	for _, o := range overrides {
		co, ok := byChannel[o.ChannelID]
		if !ok {
			co = &channelOverride{}
			byChannel[o.ChannelID] = co
		}
		co.allow |= o.Allow
		co.deny |= o.Deny
	}

	// 6. Her kanal için effective ViewChannel hesapla
	hidden := make(map[string]bool)
	granted := make(map[string]bool)

	for channelID, co := range byChannel {
		// Discord formülü: effective = (base & ~deny) | allow
		effective := (base & ^co.deny) | co.allow
		hasView := effective.Has(models.PermViewChannel)

		if hasBaseView && !hasView {
			// Base'de var ama override kaldırmış → gizle
			hidden[channelID] = true
		} else if !hasBaseView && hasView {
			// Base'de yok ama override eklemiş → göster
			granted[channelID] = true
		}
	}

	return &ChannelVisibilityFilter{
		HasBaseView:     hasBaseView,
		HiddenChannels:  hidden,
		GrantedChannels: granted,
	}, nil
}

func (s *channelPermService) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	// ─── Cache lookup ───
	// Hot path: mesaj gönderimi, ses bağlantısı gibi sık çağrılan operasyonlarda
	// cache hit'te 3 DB query atlanır → önemli latency kazancı.
	cacheKey := userID + ":" + channelID
	if cached, ok := s.permCache.Get(cacheKey); ok {
		return cached, nil
	}

	// ─── Cache miss: DB'den hesapla ───

	// 1. Kanalın ait olduğu sunucuyu bul — server-scoped rol lookup için gerekli
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("failed to get channel for permission resolution: %w", err)
	}

	// 2. Kullanıcının o sunucudaki rollerini al
	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, channel.ServerID)
	if err != nil {
		return 0, fmt.Errorf("failed to get user roles: %w", err)
	}

	// 3. Base permissions = tüm rollerin OR'u
	var base models.Permission
	roleIDs := make([]string, len(roles))
	for i, role := range roles {
		base |= role.Permissions
		roleIDs[i] = role.ID
	}

	// 4. Admin → tüm yetkiler, override'ları bypass
	if base.Has(models.PermAdmin) {
		s.permCache.Set(cacheKey, models.PermAll)
		return models.PermAll, nil
	}

	// 5. Bu kanal için kullanıcının rollerine ait override'ları al
	overrides, err := s.permRepo.GetByChannelAndRoles(ctx, channelID, roleIDs)
	if err != nil {
		return 0, fmt.Errorf("failed to get channel overrides for roles: %w", err)
	}

	// Override yoksa base döner
	if len(overrides) == 0 {
		s.permCache.Set(cacheKey, base)
		return base, nil
	}

	// 6. Tüm override'ların allow ve deny bit'lerini OR'la
	//
	// Neden OR? Bir kullanıcı birden fazla role sahip olabilir.
	// Eğer Rol-A allow=SendMessages ve Rol-B deny=SendMessages ise,
	// Discord kuralı: allow, deny'ı override eder (allow öncelikli).
	// Bu, (base & ~deny) | allow formülünde otomatik sağlanır:
	// allow'daki bit, deny'daki aynı bit'i ezer.
	var channelAllow, channelDeny models.Permission
	for _, o := range overrides {
		channelAllow |= o.Allow
		channelDeny |= o.Deny
	}

	// 7. Discord formülü: effective = (base & ~deny) | allow
	//
	// Adım adım:
	// - base & ~deny  → deny'daki bit'leri base'den kaldır
	// - | allow       → allow'daki bit'leri ekle (deny'ı ezer)
	effective := (base & ^channelDeny) | channelAllow

	// ─── Cache store ───
	s.permCache.Set(cacheKey, effective)

	return effective, nil
}

// invalidateChannelCache, belirli bir kanala ait TÜM permission cache entry'lerini siler.
//
// Key format "userID:channelID" olduğundan, channelID suffix'i ile eşleşen
// tüm entry'ler silinir. Override değiştiğinde hangi kullanıcıların etkilendiğini
// bilemeyiz (bir rol birçok kullanıcıya atanmış olabilir), bu yüzden
// o kanaldaki TÜM kullanıcıların cache'ini temizlemek güvenli yaklaşım.
func (s *channelPermService) invalidateChannelCache(channelID string) {
	suffix := ":" + channelID
	s.permCache.DeleteFunc(func(key string) bool {
		return strings.HasSuffix(key, suffix)
	})
}
