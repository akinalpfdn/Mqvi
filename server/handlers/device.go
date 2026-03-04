package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// DeviceHandler, E2EE cihaz yönetimi HTTP endpoint'lerini barındırır.
//
// Endpoint'ler:
// POST   /api/devices                           — Cihaz kaydet + prekey bundle yükle
// GET    /api/devices                           — Kendi cihazlarını listele
// DELETE /api/devices/{deviceId}                — Cihaz sil
// POST   /api/devices/{deviceId}/prekeys        — One-time prekey yükle
// PUT    /api/devices/{deviceId}/signed-prekey   — Signed prekey döndür (rotation)
// GET    /api/devices/{deviceId}/prekey-count    — Kalan prekey sayısını al
// GET    /api/users/{userId}/devices             — Kullanıcının public cihaz listesi
// GET    /api/users/{userId}/prekey-bundles      — Prekey bundle'ları al (X3DH için)
type DeviceHandler struct {
	deviceService services.DeviceService
}

// NewDeviceHandler, constructor — DeviceHandler pointer döner.
func NewDeviceHandler(deviceService services.DeviceService) *DeviceHandler {
	return &DeviceHandler{deviceService: deviceService}
}

// Register, yeni cihaz kaydeder ve opsiyonel olarak prekey'leri yükler.
// POST /api/devices
func (h *DeviceHandler) Register(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req models.RegisterDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	device, err := h.deviceService.RegisterDevice(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, device)
}

// List, kullanıcının kendi cihazlarını listeler.
// GET /api/devices
func (h *DeviceHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	devices, err := h.deviceService.ListDevices(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, devices)
}

// Delete, kullanıcının bir cihazını siler.
// DELETE /api/devices/{deviceId}
func (h *DeviceHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	deviceID := r.PathValue("deviceId")
	if deviceID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "device_id is required")
		return
	}

	if err := h.deviceService.DeleteDevice(r.Context(), user.ID, deviceID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, nil)
}

// UploadPrekeys, cihaz için yeni one-time prekey'ler yükler.
// POST /api/devices/{deviceId}/prekeys
func (h *DeviceHandler) UploadPrekeys(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	deviceID := r.PathValue("deviceId")
	if deviceID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "device_id is required")
		return
	}

	var req models.UploadPrekeysRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.deviceService.UploadPrekeys(r.Context(), user.ID, deviceID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, nil)
}

// UpdateSignedPrekey, cihazın signed prekey'ini günceller (rotasyon).
// PUT /api/devices/{deviceId}/signed-prekey
func (h *DeviceHandler) UpdateSignedPrekey(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	deviceID := r.PathValue("deviceId")
	if deviceID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "device_id is required")
		return
	}

	var req models.UpdateSignedPrekeyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.deviceService.UpdateSignedPrekey(r.Context(), user.ID, deviceID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, nil)
}

// GetPrekeyCount, cihazın kalan prekey sayısını döner.
// GET /api/devices/{deviceId}/prekey-count
func (h *DeviceHandler) GetPrekeyCount(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	deviceID := r.PathValue("deviceId")
	if deviceID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "device_id is required")
		return
	}

	count, err := h.deviceService.GetPrekeyCount(r.Context(), user.ID, deviceID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]int{"count": count})
}

// ListPublicDevices, başka bir kullanıcının public cihaz bilgilerini döner.
// GET /api/users/{userId}/devices
func (h *DeviceHandler) ListPublicDevices(w http.ResponseWriter, r *http.Request) {
	// Auth middleware'den geçen kullanıcı — erişim kontrolü
	_, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	targetUserID := r.PathValue("userId")
	if targetUserID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user_id is required")
		return
	}

	devices, err := h.deviceService.ListPublicDevices(r.Context(), targetUserID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, devices)
}

// GetPrekeyBundles, kullanıcının tüm cihazlarının prekey bundle'larını döner.
// İlk mesaj gönderilirken çağrılır — her cihaz için ayrı X3DH session kurulur.
// GET /api/users/{userId}/prekey-bundles
func (h *DeviceHandler) GetPrekeyBundles(w http.ResponseWriter, r *http.Request) {
	// Auth middleware'den geçen kullanıcı — erişim kontrolü
	_, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	targetUserID := r.PathValue("userId")
	if targetUserID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user_id is required")
		return
	}

	bundles, err := h.deviceService.GetPrekeyBundles(r.Context(), targetUserID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, bundles)
}
