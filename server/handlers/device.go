package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// DeviceHandler handles E2EE device management endpoints.
type DeviceHandler struct {
	deviceService services.DeviceService
}

func NewDeviceHandler(deviceService services.DeviceService) *DeviceHandler {
	return &DeviceHandler{deviceService: deviceService}
}

// Register registers a new device with optional prekey upload.
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

// List returns the current user's devices.
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

// Delete removes a user's device.
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

// UploadPrekeys uploads new one-time prekeys for a device.
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

// UpdateSignedPrekey rotates the device's signed prekey.
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

// GetPrekeyCount returns remaining prekey count for a device.
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

// ListPublicDevices returns another user's public device info.
// GET /api/users/{userId}/devices
func (h *DeviceHandler) ListPublicDevices(w http.ResponseWriter, r *http.Request) {
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

// GetPrekeyBundles returns prekey bundles for all of a user's devices.
// Called when initiating X3DH -- separate session per device.
// GET /api/users/{userId}/prekey-bundles
func (h *DeviceHandler) GetPrekeyBundles(w http.ResponseWriter, r *http.Request) {
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
