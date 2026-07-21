// Package services — DM message CRUD.
// Privacy enforcement (block / friends_only / message_request) lives in
// SendMessage; broadcasts are deferred to BroadcastCreate so attachments
// uploaded at the handler layer ship together with the message event.
package services

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

// SetPushNotifier wires the (optional) push notifier. No-op safe: BroadcastCreate
// guards on nil, so push stays disabled when never set.
func (s *dmService) SetPushNotifier(n PushNotifier) {
	s.pushNotifier = n
}

func (s *dmService) GetMessages(ctx context.Context, userID, channelID string, beforeID string, limit int) (*models.DMMessagePage, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	messages, err := s.dmRepo.GetMessages(ctx, channelID, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to get DM messages: %w", err)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	// Reverse: DB returns DESC, frontend expects ASC
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}

	return &models.DMMessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// rejectPlaintextOnEncryptedDM refuses an unencrypted message on a conversation that mandates E2EE.
// The client alone picks the path, so a client that misreads the state would store it in the clear.
func rejectPlaintextOnEncryptedDM(channel *models.DMChannel, encryptionVersion int) error {
	if encryptionVersion == 1 || !channel.E2EEEnabled {
		return nil
	}
	return pkg.WithCode(
		fmt.Errorf("%w: this conversation requires end-to-end encrypted messages", pkg.ErrBadRequest),
		pkg.CodeEncryptionRequired,
	)
}

// SendMessage creates a DM message. WS broadcast is done via BroadcastCreate after file uploads.
func (s *dmService) SendMessage(ctx context.Context, userID, channelID string, req *models.CreateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}

	if err := rejectPlaintextOnEncryptedDM(channel, req.EncryptionVersion); err != nil {
		return nil, err
	}

	otherUserID := channel.User1ID
	if channel.User1ID == userID {
		otherUserID = channel.User2ID
	}

	// Reject sending to a deleted/tombstone recipient — DM channel may still exist
	// but the other party is gone.
	if _, err := s.userRepo.GetActiveByID(ctx, otherUserID); err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: recipient is no longer available", pkg.ErrNotFound)
		}
		return nil, fmt.Errorf("failed to look up recipient: %w", err)
	}

	sender, _ := s.userRepo.GetByID(ctx, userID)
	isPlatformAdmin := sender != nil && sender.IsPlatformAdmin

	// Bidirectional block check — platform admins bypass
	if !isPlatformAdmin && s.blockChecker != nil {
		blocked, err := s.blockChecker.IsBlocked(ctx, userID, otherUserID)
		if err != nil {
			return nil, fmt.Errorf("failed to check block status: %w", err)
		}
		if blocked {
			return nil, fmt.Errorf("%w: cannot send message to blocked user", pkg.ErrForbidden)
		}
	}

	// DM privacy + request enforcement

	if !isPlatformAdmin {
		if channel.Status == models.DMStatusPending {
			// Initiator already sent their 1 message
			if channel.InitiatedBy != nil && *channel.InitiatedBy == userID {
				return nil, fmt.Errorf("%w: dm_request_pending", pkg.ErrForbidden)
			}
			// Recipient must accept first
			if channel.InitiatedBy != nil && *channel.InitiatedBy != userID {
				return nil, fmt.Errorf("%w: dm_request_not_accepted", pkg.ErrForbidden)
			}
		}

		// Only a never-requested channel (InitiatedBy==nil) starts the request flow.
		// Once a request was accepted InitiatedBy stays set, so messages flow freely
		// even before the recipient replies — otherwise the initiator gets stuck on 403.
		if channel.Status == models.DMStatusAccepted && channel.InitiatedBy == nil && s.friendChecker != nil {
			recipient, _ := s.userRepo.GetByID(ctx, otherUserID)
			if recipient != nil && recipient.DMPrivacy == "message_request" {
				friends, err := s.friendChecker.AreFriends(ctx, userID, otherUserID)
				if err != nil {
					return nil, fmt.Errorf("failed to check friendship: %w", err)
				}
				if !friends {
					// Skip request flow if the conversation is already established:
					// the other party has sent messages, meaning the request was
					// previously accepted and a back-and-forth is in progress.
					otherMsgCount, err := s.dmRepo.CountMessagesBySender(ctx, channelID, otherUserID)
					if err != nil {
						return nil, fmt.Errorf("failed to count messages: %w", err)
					}
					if otherMsgCount == 0 {
						msgCount, err := s.dmRepo.CountMessagesBySender(ctx, channelID, userID)
						if err != nil {
							return nil, fmt.Errorf("failed to count messages: %w", err)
						}
						if msgCount == 0 {
							// First message: transition channel to pending
							_ = s.dmRepo.UpdateChannelStatus(ctx, channelID, models.DMStatusPending)
							channel.Status = models.DMStatusPending
							channel.InitiatedBy = &userID
							_ = s.dmRepo.SetInitiatedBy(ctx, channelID, userID)
						} else {
							return nil, fmt.Errorf("%w: dm_request_pending", pkg.ErrForbidden)
						}
					}
				}
			}
			// friends_only at send time: block non-friends entirely
			if recipient != nil && recipient.DMPrivacy == "friends_only" {
				friends, err := s.friendChecker.AreFriends(ctx, userID, otherUserID)
				if err != nil {
					return nil, fmt.Errorf("failed to check friendship: %w", err)
				}
				if !friends {
					return nil, fmt.Errorf("%w: this user only accepts messages from friends", pkg.ErrForbidden)
				}
			}
		}
	}

	// Reply validation
	if req.ReplyToID != nil && *req.ReplyToID != "" {
		refMsg, err := s.dmRepo.GetMessageByID(ctx, *req.ReplyToID)
		if err != nil {
			return nil, fmt.Errorf("%w: referenced message not found", pkg.ErrBadRequest)
		}
		if refMsg.DMChannelID != channelID {
			return nil, fmt.Errorf("%w: referenced message is not in this DM channel", pkg.ErrBadRequest)
		}
	}

	var contentPtr *string
	if req.Content != "" {
		contentPtr = &req.Content
	}

	msg := &models.DMMessage{
		DMChannelID:       channelID,
		UserID:            userID,
		Content:           contentPtr,
		ReplyToID:         req.ReplyToID,
		EncryptionVersion: req.EncryptionVersion,
		Ciphertext:        req.Ciphertext,
		SenderDeviceID:    req.SenderDeviceID,
		E2EEMetadata:      req.E2EEMetadata,
	}

	if err := s.dmRepo.CreateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("failed to create DM message: %w", err)
	}

	author, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get message author: %w", err)
	}
	author.PasswordHash = ""
	author.AvatarURL = s.urlSigner.SignURLPtr(author.AvatarURL)
	msg.Author = author

	// Load reply reference
	if msg.ReplyToID != nil && *msg.ReplyToID != "" {
		refMsg, err := s.dmRepo.GetMessageByID(ctx, *msg.ReplyToID)
		if err == nil {
			ref := &models.MessageReference{
				ID:      refMsg.ID,
				Content: refMsg.Content,
			}
			if refMsg.Author != nil {
				refMsg.Author.PasswordHash = ""
				refMsg.Author.AvatarURL = s.urlSigner.SignURLPtr(refMsg.Author.AvatarURL)
				ref.Author = refMsg.Author
			}
			msg.ReferencedMessage = ref
		}
	}

	msg.Attachments = []models.DMAttachment{}
	msg.Reactions = []models.ReactionGroup{}

	// Auto-unhide: if either user hid this DM, show it again on new message (best-effort)
	if s.unhider != nil {
		_ = s.unhider.UnhideForNewMessage(ctx, otherUserID, channelID)
		_ = s.unhider.UnhideForNewMessage(ctx, userID, channelID)
	}

	return msg, nil
}

// CreateCallLog writes a plaintext system message recording a finished P2P call
// into the DM channel between the two users and broadcasts it to both. Plaintext
// (encryption_version=0) — it carries call metadata, not private content. Bypasses
// the DM-request/privacy gate of SendMessage: the parties are friends (P2P calls
// require it) and this is server-generated.
func (s *dmService) CreateCallLog(ctx context.Context, callerID, receiverID string, meta models.CallMeta) error {
	channel, err := s.GetOrCreateChannel(ctx, callerID, receiverID)
	if err != nil {
		return fmt.Errorf("call log: get/create channel: %w", err)
	}

	msg := &models.DMMessage{
		DMChannelID: channel.ID,
		UserID:      meta.CallerID,
		MessageType: models.MessageTypeCall,
		CallMeta:    &meta,
	}
	if err := s.dmRepo.CreateMessage(ctx, msg); err != nil {
		return fmt.Errorf("call log: create message: %w", err)
	}

	if author, aErr := s.userRepo.GetByID(ctx, meta.CallerID); aErr == nil && author != nil {
		author.PasswordHash = ""
		author.AvatarURL = s.urlSigner.SignURLPtr(author.AvatarURL)
		msg.Author = author
	}
	msg.Attachments = []models.DMAttachment{}
	msg.Reactions = []models.ReactionGroup{}

	// Resurface a hidden DM on a missed/finished call (best-effort).
	if s.unhider != nil {
		_ = s.unhider.UnhideForNewMessage(ctx, callerID, channel.ID)
		_ = s.unhider.UnhideForNewMessage(ctx, receiverID, channel.ID)
	}

	event := ws.Event{Op: ws.OpDMMessageCreate, Data: msg}
	s.hub.BroadcastToUser(callerID, event)
	s.hub.BroadcastToUser(receiverID, event)
	return nil
}

// BroadcastCreate sends the DM message to both users after file uploads complete.
func (s *dmService) BroadcastCreate(message *models.DMMessage) {
	channel, err := s.dmRepo.GetChannelByID(context.Background(), message.DMChannelID)
	if err != nil {
		return
	}

	event := ws.Event{
		Op:   ws.OpDMMessageCreate,
		Data: message,
	}
	s.broadcastToBothUsers(channel, event)

	// Push the offline recipient (mobile), off the WS/response path. Skips call-log
	// system messages and conversations the recipient muted. Mute-check failure fails
	// open (push) so a transient DB error never silently swallows notifications.
	if s.pushNotifier != nil && message.MessageType != models.MessageTypeCall {
		go func() {
			recipientID := channel.User1ID
			if recipientID == message.UserID {
				recipientID = channel.User2ID
			}
			muted, err := s.dmRepo.IsChannelMuted(context.Background(), recipientID, channel.ID)
			if err != nil {
				log.Printf("[dm] push mute check failed for %s/%s: %v", recipientID, channel.ID, err)
			}
			if muted {
				return
			}
			content := ""
			if message.Content != nil {
				content = *message.Content
			}
			s.pushNotifier.NotifyDM(recipientID, pushDisplayName(message.Author), content, message.EncryptionVersion == 1, channel.ID, message.UserID, message.ID)
		}()
	}

	// If channel just became pending, notify both users
	if channel.Status == models.DMStatusPending {
		s.broadcastToBothUsers(channel, ws.Event{
			Op: ws.OpDMChannelStatusChange,
			Data: map[string]any{
				"dm_channel_id": channel.ID,
				"status":        channel.Status,
				"initiated_by":  channel.InitiatedBy,
			},
		})
	}
}

func (s *dmService) EditMessage(ctx context.Context, userID, messageID string, req *models.UpdateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return nil, err
	}

	if msg.UserID != userID {
		return nil, fmt.Errorf("%w: you can only edit your own messages", pkg.ErrForbidden)
	}

	// An edit writes `content` without touching encryption_version or ciphertext, so a plaintext
	// edit of an encrypted message leaves readable text beside the ciphertext the UI still shows.
	if err := rejectPlaintextOnEncryptedDM(channel, req.EncryptionVersion); err != nil {
		return nil, err
	}

	if err := s.dmRepo.UpdateMessage(ctx, messageID, req); err != nil {
		return nil, err
	}

	updated, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return nil, err
	}

	enriched := []models.DMMessage{*updated}
	if err := s.enrichMessages(ctx, enriched); err != nil {
		return nil, err
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op:   ws.OpDMMessageUpdate,
		Data: &enriched[0],
	})

	return &enriched[0], nil
}

func (s *dmService) DeleteMessage(ctx context.Context, userID, messageID string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	if msg.UserID != userID {
		return fmt.Errorf("%w: you can only delete your own messages", pkg.ErrForbidden)
	}

	// Collect attachment info before delete (CASCADE removes attachment rows)
	var attachmentBytes int64
	var dmAtts []models.DMAttachment
	attMap, attErr := s.dmRepo.GetAttachmentsByMessageIDs(ctx, []string{messageID})
	if attErr != nil {
		log.Printf("[dm] failed to fetch attachments for message %s (orphan files may remain): %v", messageID, attErr)
	} else {
		dmAtts = attMap[messageID]
	}
	for _, a := range dmAtts {
		s.fileDeleter.DeleteFromURL(a.FileURL)
		// The companion thumbnail is a separate file; without this it outlives its original until
		// the orphan sweep. It carries no quota, so only the original counts toward the release.
		if a.ThumbURL != nil {
			s.fileDeleter.DeleteFromURL(*a.ThumbURL)
		}
		if a.FileSize != nil {
			attachmentBytes += *a.FileSize
		}
		// The thumbnail was charged at upload, so it has to be given back here too.
		if a.ThumbSize != nil {
			attachmentBytes += *a.ThumbSize
		}
	}

	if err := s.dmRepo.DeleteMessage(ctx, messageID); err != nil {
		return err
	}

	// Release storage quota for deleted attachments
	if attachmentBytes > 0 {
		if err := s.storageService.Release(ctx, msg.UserID, attachmentBytes); err != nil {
			log.Printf("[dm] failed to release storage quota for user %s: %v", msg.UserID, err)
		}
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMMessageDelete,
		Data: map[string]string{
			"id":            messageID,
			"dm_channel_id": msg.DMChannelID,
		},
	})

	return nil
}
