package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type SoundboardHandler struct {
	service   services.SoundboardService
	maxUpload int64
	urlSigner services.FileURLSigner
}

func NewSoundboardHandler(service services.SoundboardService, maxUpload int64, urlSigner services.FileURLSigner) *SoundboardHandler {
	return &SoundboardHandler{service: service, maxUpload: maxUpload, urlSigner: urlSigner}
}

// List returns all sounds for a server.
func (h *SoundboardHandler) List(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	sounds, err := h.service.List(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	for i := range sounds {
		sounds[i].FileURL = h.urlSigner.SignURL(sounds[i].FileURL)
	}
	pkg.JSON(w, http.StatusOK, sounds)
}

// Create uploads a new sound.
func (h *SoundboardHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	if err := r.ParseMultipartForm(h.maxUpload); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	name := r.FormValue("name")
	emoji := r.FormValue("emoji")
	durationStr := r.FormValue("duration_ms")

	durationMs, err := strconv.Atoi(durationStr)
	if err != nil || durationMs <= 0 {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "duration_ms is required and must be a positive integer")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	req := &models.CreateSoundboardSoundRequest{
		Name: name,
	}
	if emoji != "" {
		req.Emoji = &emoji
	}

	sound, err := h.service.Create(r.Context(), serverID, user.ID, req, file, header, durationMs)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	sound.FileURL = h.urlSigner.SignURL(sound.FileURL)
	pkg.JSON(w, http.StatusCreated, sound)
}

// Update modifies a sound's name or emoji.
func (h *SoundboardHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("soundId")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "sound id required")
		return
	}

	var req models.UpdateSoundboardSoundRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	sound, err := h.service.Update(r.Context(), id, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	sound.FileURL = h.urlSigner.SignURL(sound.FileURL)
	pkg.JSON(w, http.StatusOK, sound)
}

// Delete removes a sound.
func (h *SoundboardHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("soundId")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "sound id required")
		return
	}

	if err := h.service.Delete(r.Context(), id); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Play broadcasts a sound to the voice channel.
func (h *SoundboardHandler) Play(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	soundID := r.PathValue("soundId")
	if soundID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "sound id required")
		return
	}

	if err := h.service.Play(r.Context(), serverID, soundID, user.ID, user.Username); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
