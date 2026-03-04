package services

import (
	"context"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// PrekeyLowThreshold, prekey havuzu bu sayının altına düşünce
// client'a "prekey_low" WS event'i gönderilir.
// Client bu event'i aldığında yeni prekey batch'i yüklemelidir.
const PrekeyLowThreshold = 10

// DeviceService, E2EE cihaz kayıt ve prekey yönetimi iş mantığını tanımlar.
//
// Sorumluluklar:
// - Cihaz kaydı (register) ve kaldırma (delete)
// - Prekey bundle yönetimi (upload, consume, rotate)
// - Prekey havuz durumu kontrolü ve "prekey_low" bildirimi
// - Cihaz listesi (kendi cihazlar + başka kullanıcının public cihazları)
type DeviceService interface {
	// RegisterDevice, yeni bir cihaz kaydeder ve varsa prekey'leri yükler.
	// Başarılı kayıt sonrası diğer cihazlara "device_list_update" broadcast edilir.
	RegisterDevice(ctx context.Context, userID string, req *models.RegisterDeviceRequest) (*models.Device, error)

	// ListDevices, kullanıcının kendi cihazlarını döner (tam bilgi).
	ListDevices(ctx context.Context, userID string) ([]models.Device, error)

	// ListPublicDevices, başka bir kullanıcının public cihaz bilgilerini döner.
	ListPublicDevices(ctx context.Context, userID string) ([]models.DevicePublicInfo, error)

	// DeleteDevice, kullanıcının bir cihazını siler.
	// Diğer cihazlara "device_list_update" broadcast edilir.
	DeleteDevice(ctx context.Context, userID, deviceID string) error

	// UpdateSignedPrekey, cihazın signed prekey'ini günceller (rotasyon).
	// Diğer cihazlara "device_key_change" broadcast edilir.
	UpdateSignedPrekey(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error

	// UploadPrekeys, cihaz için yeni one-time prekey'ler yükler.
	UploadPrekeys(ctx context.Context, userID, deviceID string, req *models.UploadPrekeysRequest) error

	// GetPrekeyBundles, kullanıcının tüm cihazlarının prekey bundle'larını döner.
	// İlk mesaj gönderilirken çağrılır — her cihaz için ayrı şifreleme yapılır.
	GetPrekeyBundles(ctx context.Context, userID string) ([]models.PrekeyBundle, error)

	// GetPrekeyCount, cihazın kalan prekey sayısını döner.
	GetPrekeyCount(ctx context.Context, userID, deviceID string) (int, error)
}

// deviceService, DeviceService interface'inin implementasyonu.
type deviceService struct {
	deviceRepo repository.DeviceRepository
	hub        ws.Broadcaster
}

// NewDeviceService, constructor — DeviceService interface döner.
//
// hub: Cihaz değişikliklerinde (kayıt, silme, key rotation)
// kullanıcının diğer cihazlarına bildirim göndermek için.
func NewDeviceService(deviceRepo repository.DeviceRepository, hub ws.Broadcaster) DeviceService {
	return &deviceService{
		deviceRepo: deviceRepo,
		hub:        hub,
	}
}

func (s *deviceService) RegisterDevice(ctx context.Context, userID string, req *models.RegisterDeviceRequest) (*models.Device, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Device struct oluştur — displayName ve signingKey opsiyonel
	device := &models.Device{
		UserID:         userID,
		DeviceID:       req.DeviceID,
		IdentityKey:    req.IdentityKey,
		SignedPrekey:    req.SignedPrekey,
		SignedPrekeyID:  req.SignedPrekeyID,
		SignedPrekeySig: req.SignedPrekeySig,
		RegistrationID:  req.RegistrationID,
	}
	if req.DisplayName != "" {
		device.DisplayName = &req.DisplayName
	}
	if req.SigningKey != "" {
		device.SigningKey = &req.SigningKey
	}

	// UPSERT — aynı device_id varsa güncellenir
	if err := s.deviceRepo.Register(ctx, device); err != nil {
		return nil, fmt.Errorf("failed to register device: %w", err)
	}

	// One-time prekey'ler varsa yükle
	if len(req.OneTimePrekeys) > 0 {
		if err := s.deviceRepo.UploadPrekeys(ctx, userID, req.DeviceID, req.OneTimePrekeys); err != nil {
			return nil, fmt.Errorf("failed to upload initial prekeys: %w", err)
		}
	}

	// Kullanıcının diğer cihazlarına bildirim — yeni cihaz eklendi
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDeviceListUpdate,
		Data: DeviceListUpdateData{UserID: userID, Action: "added", DeviceID: req.DeviceID},
	})

	return device, nil
}

func (s *deviceService) ListDevices(ctx context.Context, userID string) ([]models.Device, error) {
	devices, err := s.deviceRepo.ListByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list devices: %w", err)
	}
	if devices == nil {
		devices = []models.Device{}
	}
	return devices, nil
}

func (s *deviceService) ListPublicDevices(ctx context.Context, userID string) ([]models.DevicePublicInfo, error) {
	devices, err := s.deviceRepo.ListPublicByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list public devices: %w", err)
	}
	if devices == nil {
		devices = []models.DevicePublicInfo{}
	}
	return devices, nil
}

func (s *deviceService) DeleteDevice(ctx context.Context, userID, deviceID string) error {
	if err := s.deviceRepo.Delete(ctx, userID, deviceID); err != nil {
		return fmt.Errorf("failed to delete device: %w", err)
	}

	// Kullanıcının diğer cihazlarına bildirim — cihaz silindi
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDeviceListUpdate,
		Data: DeviceListUpdateData{UserID: userID, Action: "removed", DeviceID: deviceID},
	})

	return nil
}

func (s *deviceService) UpdateSignedPrekey(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if err := s.deviceRepo.UpdateSignedPrekey(ctx, userID, deviceID, req); err != nil {
		return fmt.Errorf("failed to update signed prekey: %w", err)
	}

	// Diğer kullanıcılara bildirim — identity key değişmedi ama signed prekey döndü
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDeviceKeyChange,
		Data: DeviceKeyChangeData{UserID: userID, DeviceID: deviceID},
	})

	return nil
}

func (s *deviceService) UploadPrekeys(ctx context.Context, userID, deviceID string, req *models.UploadPrekeysRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if err := s.deviceRepo.UploadPrekeys(ctx, userID, deviceID, req.OneTimePrekeys); err != nil {
		return fmt.Errorf("failed to upload prekeys: %w", err)
	}
	return nil
}

func (s *deviceService) GetPrekeyBundles(ctx context.Context, userID string) ([]models.PrekeyBundle, error) {
	bundles, err := s.deviceRepo.GetPrekeyBundles(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get prekey bundles: %w", err)
	}

	// Prekey tüketimi sonrası havuz kontrolü — her cihaz için
	s.checkPrekeyLevels(ctx, userID)

	return bundles, nil
}

func (s *deviceService) GetPrekeyCount(ctx context.Context, userID, deviceID string) (int, error) {
	count, err := s.deviceRepo.CountPrekeys(ctx, userID, deviceID)
	if err != nil {
		return 0, fmt.Errorf("failed to count prekeys: %w", err)
	}
	return count, nil
}

// checkPrekeyLevels, kullanıcının tüm cihazlarının prekey havuzunu kontrol eder.
// Havuz PrekeyLowThreshold'un altına düşmüşse ilgili cihaza "prekey_low" event'i gönderir.
func (s *deviceService) checkPrekeyLevels(ctx context.Context, userID string) {
	devices, err := s.deviceRepo.ListByUser(ctx, userID)
	if err != nil {
		log.Printf("[device] failed to list devices for prekey check: %v", err)
		return
	}

	for _, d := range devices {
		count, err := s.deviceRepo.CountPrekeys(ctx, userID, d.DeviceID)
		if err != nil {
			log.Printf("[device] failed to count prekeys for device %s: %v", d.DeviceID, err)
			continue
		}

		if count < PrekeyLowThreshold {
			s.hub.BroadcastToUser(userID, ws.Event{
				Op: ws.OpPrekeyLow,
				Data: PrekeyLowData{
					DeviceID:  d.DeviceID,
					Remaining: count,
				},
			})
		}
	}
}

// ─── WS Event Data Struct'ları ───

// DeviceListUpdateData, device_list_update event payload'ı.
// Kullanıcının cihaz listesi değiştiğinde gönderilir.
type DeviceListUpdateData struct {
	UserID   string `json:"user_id"`
	Action   string `json:"action"`    // "added" veya "removed"
	DeviceID string `json:"device_id"`
}

// DeviceKeyChangeData, device_key_change event payload'ı.
// Bir cihazın signed prekey'i döndüğünde gönderilir.
type DeviceKeyChangeData struct {
	UserID   string `json:"user_id"`
	DeviceID string `json:"device_id"`
}

// PrekeyLowData, prekey_low event payload'ı.
// Cihazın prekey havuzu threshold'un altına düştüğünde gönderilir.
type PrekeyLowData struct {
	DeviceID  string `json:"device_id"`
	Remaining int    `json:"remaining"`
}
