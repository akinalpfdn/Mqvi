// Package services — ephemeral voice channel chat.
// Access is gated to users currently in the target voice channel. The entire
// chat (DB rows + on-disk attachment files) is wiped via CleanupChannel when
// the last participant leaves (called from voiceService.stopChannelTimerLocked).
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

// VoiceChannelMembershipChecker — ISP: only what voice-chat needs from voice service.
// GetUserVoiceState answers "is this user in voice now and where?" for the membership gate.
// GetChannelParticipants returns the live audience for broadcast scoping (per-voice-channel,
// not per-server, so members not in voice don't get event noise).
type VoiceChannelMembershipChecker interface {
	GetUserVoiceState(userID string) *models.VoiceState
	GetChannelParticipants(channelID string) []models.VoiceState
}

type VoiceMessageService interface {
	Create(ctx context.Context, userID, channelID string, req *models.CreateVoiceMessageRequest) (*models.VoiceMessage, error)
	List(ctx context.Context, userID, channelID string, limit int) ([]models.VoiceMessage, error)
	Update(ctx context.Context, userID, messageID string, req *models.UpdateVoiceMessageRequest) (*models.VoiceMessage, error)
	Delete(ctx context.Context, userID, messageID string) error
	// DeleteAsModerator removes a voice-chat message for platform moderation; no membership check.
	DeleteAsModerator(ctx context.Context, messageID string) error
	// AttachFile records an uploaded file against an existing voice message.
	// Used by the handler after the upload pipeline stores the file on disk.
	AttachFile(ctx context.Context, messageID, filename, fileURL string, fileSize int64, mimeType *string) (*models.VoiceMessageAttachment, error)
	// BroadcastCreate publishes a fully-enriched create event after attachments are attached.
	BroadcastCreate(ctx context.Context, message *models.VoiceMessage)
	// CleanupChannel wipes every message + attachment file for a channel. Called on N→0.
	CleanupChannel(ctx context.Context, channelID string)
}

type voiceMessageService struct {
	repo            repository.VoiceMessageRepository
	voiceMembership VoiceChannelMembershipChecker
	hub             ws.Broadcaster
	urlSigner       FileURLSigner
	fileDeleter     FileDeleter
}

func NewVoiceMessageService(
	repo repository.VoiceMessageRepository,
	voiceMembership VoiceChannelMembershipChecker,
	hub ws.Broadcaster,
	urlSigner FileURLSigner,
	fileDeleter FileDeleter,
) VoiceMessageService {
	return &voiceMessageService{
		repo:            repo,
		voiceMembership: voiceMembership,
		hub:             hub,
		urlSigner:       urlSigner,
		fileDeleter:     fileDeleter,
	}
}

// requireMember returns the user's voice state if they're in channelID, else 403.
func (s *voiceMessageService) requireMember(userID, channelID string) (*models.VoiceState, error) {
	state := s.voiceMembership.GetUserVoiceState(userID)
	if state == nil || state.ChannelID != channelID {
		return nil, fmt.Errorf("%w: not currently in voice channel", pkg.ErrForbidden)
	}
	return state, nil
}

func (s *voiceMessageService) Create(ctx context.Context, userID, channelID string, req *models.CreateVoiceMessageRequest) (*models.VoiceMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	if _, err := s.requireMember(userID, channelID); err != nil {
		return nil, err
	}

	var contentPtr *string
	if req.Content != "" {
		contentPtr = &req.Content
	}
	msg := &models.VoiceMessage{
		ChannelID: channelID,
		UserID:    userID,
		Content:   contentPtr,
	}
	if err := s.repo.Create(ctx, msg); err != nil {
		return nil, err
	}

	// Re-fetch with author JOIN for the response payload.
	full, err := s.repo.GetByID(ctx, msg.ID)
	if err != nil {
		return nil, fmt.Errorf("reload voice message: %w", err)
	}
	return full, nil
}

func (s *voiceMessageService) List(ctx context.Context, userID, channelID string, limit int) ([]models.VoiceMessage, error) {
	if _, err := s.requireMember(userID, channelID); err != nil {
		return nil, err
	}
	msgs, err := s.repo.GetByChannelID(ctx, channelID, limit)
	if err != nil {
		return nil, err
	}
	if err := s.enrich(ctx, msgs); err != nil {
		return nil, err
	}
	if msgs == nil {
		msgs = []models.VoiceMessage{}
	}
	return msgs, nil
}

func (s *voiceMessageService) Update(ctx context.Context, userID, messageID string, req *models.UpdateVoiceMessageRequest) (*models.VoiceMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	existing, err := s.repo.GetByID(ctx, messageID)
	if err != nil {
		return nil, err
	}
	if existing.UserID != userID {
		return nil, fmt.Errorf("%w: cannot edit another user's message", pkg.ErrForbidden)
	}
	if _, err := s.requireMember(userID, existing.ChannelID); err != nil {
		return nil, err
	}
	if err := s.repo.UpdateContent(ctx, messageID, req.Content); err != nil {
		return nil, err
	}
	updated, err := s.repo.GetByID(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("reload voice message after update: %w", err)
	}
	atts, _ := s.repo.GetAttachmentsByMessageIDs(ctx, []string{updated.ID})
	updated.Attachments = s.signAttachments(atts[updated.ID])
	s.broadcastToParticipants(updated.ChannelID, ws.Event{
		Op:   ws.OpVoiceMessageUpdate,
		Data: updated,
	})
	return updated, nil
}

func (s *voiceMessageService) Delete(ctx context.Context, userID, messageID string) error {
	existing, err := s.repo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}
	if existing.UserID != userID {
		return fmt.Errorf("%w: cannot delete another user's message", pkg.ErrForbidden)
	}
	if _, err := s.requireMember(userID, existing.ChannelID); err != nil {
		return err
	}

	return s.deleteVoiceMessage(ctx, existing)
}

// DeleteAsModerator is the report-handling path; the admin is not in the voice channel.
func (s *voiceMessageService) DeleteAsModerator(ctx context.Context, messageID string) error {
	existing, err := s.repo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}
	return s.deleteVoiceMessage(ctx, existing)
}

// deleteVoiceMessage is the shared core: files, row, broadcast to current participants.
func (s *voiceMessageService) deleteVoiceMessage(ctx context.Context, existing *models.VoiceMessage) error {
	messageID := existing.ID

	// Grab attachment URLs before delete so we can purge files after the cascade.
	atts, _ := s.repo.GetAttachmentsByMessageIDs(ctx, []string{messageID})
	if err := s.repo.Delete(ctx, messageID); err != nil {
		return err
	}
	for _, a := range atts[messageID] {
		s.fileDeleter.DeleteFromURL(a.FileURL)
	}

	s.broadcastToParticipants(existing.ChannelID, ws.Event{
		Op: ws.OpVoiceMessageDelete,
		Data: ws.VoiceMessageDeleteData{
			ID:        messageID,
			ChannelID: existing.ChannelID,
		},
	})
	return nil
}

func (s *voiceMessageService) AttachFile(ctx context.Context, messageID, filename, fileURL string, fileSize int64, mimeType *string) (*models.VoiceMessageAttachment, error) {
	att := &models.VoiceMessageAttachment{
		VoiceMessageID: messageID,
		Filename:       filename,
		FileURL:        fileURL,
		FileSize:       fileSize,
		MimeType:       mimeType,
	}
	if err := s.repo.CreateAttachment(ctx, att); err != nil {
		return nil, err
	}
	return att, nil
}

func (s *voiceMessageService) BroadcastCreate(ctx context.Context, message *models.VoiceMessage) {
	// Sign attachment URLs at egress.
	atts, _ := s.repo.GetAttachmentsByMessageIDs(ctx, []string{message.ID})
	message.Attachments = s.signAttachments(atts[message.ID])

	s.broadcastToParticipants(message.ChannelID, ws.Event{
		Op:   ws.OpVoiceMessageCreate,
		Data: message,
	})
}

func (s *voiceMessageService) CleanupChannel(ctx context.Context, channelID string) {
	msgs, err := s.repo.GetByChannelID(ctx, channelID, 100000)
	if err != nil {
		log.Printf("[voice-msg] cleanup list failed channel=%s: %v", channelID, err)
		return
	}
	if len(msgs) == 0 {
		return
	}
	ids := make([]string, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	atts, _ := s.repo.GetAttachmentsByMessageIDs(ctx, ids)

	if _, err := s.repo.DeleteByChannel(ctx, channelID); err != nil {
		log.Printf("[voice-msg] cleanup delete failed channel=%s: %v", channelID, err)
		return
	}
	for _, list := range atts {
		for _, a := range list {
			s.fileDeleter.DeleteFromURL(a.FileURL)
		}
	}
	log.Printf("[voice-msg] cleaned %d messages for channel %s", len(msgs), channelID)
}

func (s *voiceMessageService) enrich(ctx context.Context, msgs []models.VoiceMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	ids := make([]string, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	atts, err := s.repo.GetAttachmentsByMessageIDs(ctx, ids)
	if err != nil {
		return fmt.Errorf("load voice message attachments: %w", err)
	}
	for i := range msgs {
		msgs[i].Attachments = s.signAttachments(atts[msgs[i].ID])
	}
	return nil
}

func (s *voiceMessageService) signAttachments(atts []models.VoiceMessageAttachment) []models.VoiceMessageAttachment {
	if len(atts) == 0 {
		return nil
	}
	out := make([]models.VoiceMessageAttachment, len(atts))
	for i, a := range atts {
		a.FileURL = s.urlSigner.SignURL(a.FileURL)
		out[i] = a
	}
	return out
}

// broadcastToParticipants sends an event only to users currently in the voice channel,
// matching the ephemeral-by-presence semantic — people not in voice don't get noise.
func (s *voiceMessageService) broadcastToParticipants(channelID string, event ws.Event) {
	participants := s.voiceMembership.GetChannelParticipants(channelID)
	if len(participants) == 0 {
		return
	}
	userIDs := make([]string, len(participants))
	for i, p := range participants {
		userIDs[i] = p.UserID
	}
	s.hub.BroadcastToUsers(userIDs, event)
}
