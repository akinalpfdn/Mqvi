package services

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

var mentionRegex = regexp.MustCompile(`@(\w+)`)

type MessageService interface {
	GetByChannelID(ctx context.Context, channelID string, userID string, beforeID string, limit int) (*models.MessagePage, error)
	Create(ctx context.Context, channelID string, userID string, req *models.CreateMessageRequest) (*models.Message, error)
	BroadcastCreate(message *models.Message)
	Update(ctx context.Context, id string, userID string, req *models.UpdateMessageRequest) (*models.Message, error)
	Delete(ctx context.Context, id string, userID string, userPermissions models.Permission) error
}

type messageService struct {
	messageRepo     repository.MessageRepository
	attachmentRepo  repository.AttachmentRepository
	channelRepo     repository.ChannelRepository
	userRepo        repository.UserRepository
	mentionRepo     repository.MentionRepository
	roleMentionRepo repository.RoleMentionRepository
	roleRepo        repository.RoleRepository
	reactionRepo    repository.ReactionRepository
	hub             ws.BroadcastAndOnline
	permResolver    ChannelPermResolver
}

func NewMessageService(
	messageRepo repository.MessageRepository,
	attachmentRepo repository.AttachmentRepository,
	channelRepo repository.ChannelRepository,
	userRepo repository.UserRepository,
	mentionRepo repository.MentionRepository,
	roleMentionRepo repository.RoleMentionRepository,
	roleRepo repository.RoleRepository,
	reactionRepo repository.ReactionRepository,
	hub ws.BroadcastAndOnline,
	permResolver ChannelPermResolver,
) MessageService {
	return &messageService{
		messageRepo:     messageRepo,
		attachmentRepo:  attachmentRepo,
		channelRepo:     channelRepo,
		userRepo:        userRepo,
		mentionRepo:     mentionRepo,
		roleMentionRepo: roleMentionRepo,
		roleRepo:        roleRepo,
		reactionRepo:    reactionRepo,
		hub:             hub,
		permResolver:    permResolver,
	}
}

// GetByChannelID returns messages with cursor-based pagination.
// Checks per-channel ReadMessages permission (override-aware).
func (s *messageService) GetByChannelID(ctx context.Context, channelID string, userID string, beforeID string, limit int) (*models.MessagePage, error) {
	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !channelPerms.Has(models.PermReadMessages) {
		return nil, fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
	}

	if limit <= 0 || limit > 100 {
		limit = 50
	}

	// Fetch limit+1 to determine if more pages exist
	messages, err := s.messageRepo.GetByChannelID(ctx, channelID, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to get messages: %w", err)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	// Reverse: DB returns DESC, frontend expects ASC (oldest first)
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	// Batch load attachments, mentions, reactions (avoid N+1)
	if len(messages) > 0 {
		messageIDs := make([]string, len(messages))
		for i, m := range messages {
			messageIDs[i] = m.ID
		}

		attachments, err := s.attachmentRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get attachments: %w", err)
		}

		attachmentMap := make(map[string][]models.Attachment)
		for _, a := range attachments {
			attachmentMap[a.MessageID] = append(attachmentMap[a.MessageID], a)
		}

		mentionMap, err := s.mentionRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get mentions: %w", err)
		}

		reactionMap, err := s.reactionRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get reactions: %w", err)
		}

		roleMentionMap, err := s.roleMentionRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get role mentions: %w", err)
		}

		for i := range messages {
			messages[i].Attachments = attachmentMap[messages[i].ID]
			if messages[i].Attachments == nil {
				messages[i].Attachments = []models.Attachment{}
			}
			messages[i].Mentions = mentionMap[messages[i].ID]
			if messages[i].Mentions == nil {
				messages[i].Mentions = []string{}
			}
			messages[i].RoleMentions = roleMentionMap[messages[i].ID]
			if messages[i].RoleMentions == nil {
				messages[i].RoleMentions = []string{}
			}
			messages[i].Reactions = reactionMap[messages[i].ID]
			if messages[i].Reactions == nil {
				messages[i].Reactions = []models.ReactionGroup{}
			}
		}
	}

	// nil slice serializes as JSON null — ensure empty array
	if messages == nil {
		messages = []models.Message{}
	}

	return &models.MessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// Create creates a new message. Checks per-channel SendMessages permission.
// WS broadcast is NOT done here — handler calls BroadcastCreate after file uploads.
func (s *messageService) Create(ctx context.Context, channelID string, userID string, req *models.CreateMessageRequest) (*models.Message, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if _, err := s.channelRepo.GetByID(ctx, channelID); err != nil {
		return nil, err
	}

	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !channelPerms.Has(models.PermSendMessages) {
		return nil, fmt.Errorf("%w: missing send messages permission for this channel", pkg.ErrForbidden)
	}

	message := &models.Message{
		ChannelID:         channelID,
		UserID:            userID,
		EncryptionVersion: req.EncryptionVersion,
		Ciphertext:        req.Ciphertext,
		SenderDeviceID:    req.SenderDeviceID,
		E2EEMetadata:      req.E2EEMetadata,
	}

	// E2EE messages have nil Content — payload is in Ciphertext
	if req.EncryptionVersion == 0 {
		message.Content = &req.Content
	}

	// Reply validation — referenced message must be in the same channel
	if req.ReplyToID != nil && *req.ReplyToID != "" {
		refMsg, err := s.messageRepo.GetByID(ctx, *req.ReplyToID)
		if err != nil {
			return nil, fmt.Errorf("%w: referenced message not found", pkg.ErrBadRequest)
		}
		if refMsg.ChannelID != channelID {
			return nil, fmt.Errorf("%w: cannot reply to a message in a different channel", pkg.ErrBadRequest)
		}
		message.ReplyToID = req.ReplyToID
	}

	if err := s.messageRepo.Create(ctx, message); err != nil {
		return nil, fmt.Errorf("failed to create message: %w", err)
	}

	author, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get message author: %w", err)
	}
	author.PasswordHash = ""
	message.Author = author
	message.Attachments = []models.Attachment{}
	message.Reactions = []models.ReactionGroup{}

	// Load reply reference for API response / WS broadcast
	if message.ReplyToID != nil {
		refMsg, err := s.messageRepo.GetByID(ctx, *message.ReplyToID)
		if err == nil && refMsg != nil {
			message.ReferencedMessage = &models.MessageReference{
				ID:      refMsg.ID,
				Author:  refMsg.Author,
				Content: refMsg.Content,
			}
		}
		// If deleted, ReferencedMessage stays nil
	}

	// Parse and save mentions (server can't read E2EE content)
	if req.EncryptionVersion == 0 {
		channel, _ := s.channelRepo.GetByID(ctx, channelID)
		serverID := ""
		if channel != nil {
			serverID = channel.ServerID
		}

		mentionedIDs := s.extractMentions(ctx, req.Content)
		if len(mentionedIDs) > 0 {
			if err := s.mentionRepo.SaveMentions(ctx, message.ID, mentionedIDs); err != nil {
				fmt.Printf("[mention] failed to save mentions for message %s: %v\n", message.ID, err)
			}
		}
		message.Mentions = mentionedIDs

		roleMentionIDs := s.extractRoleMentions(ctx, req.Content, serverID)
		if len(roleMentionIDs) > 0 {
			if err := s.roleMentionRepo.SaveRoleMentions(ctx, message.ID, roleMentionIDs); err != nil {
				fmt.Printf("[mention] failed to save role mentions for message %s: %v\n", message.ID, err)
			}
		}
		message.RoleMentions = roleMentionIDs
	} else {
		message.Mentions = []string{}
		message.RoleMentions = []string{}
	}

	return message, nil
}

// BroadcastCreate sends the message via WS after file uploads complete.
// Only sends to users with ReadMessages permission on the channel.
func (s *messageService) BroadcastCreate(message *models.Message) {
	event := ws.Event{
		Op:   ws.OpMessageCreate,
		Data: message,
	}

	onlineUsers := s.hub.GetOnlineUserIDs()
	ctx := context.Background()
	var allowed []string

	for _, userID := range onlineUsers {
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, message.ChannelID)
		if err != nil {
			continue
		}
		if perms.Has(models.PermReadMessages) {
			allowed = append(allowed, userID)
		}
	}

	s.hub.BroadcastToUsers(allowed, event)
}

// Update edits a message. Only the message owner can edit.
func (s *messageService) Update(ctx context.Context, id string, userID string, req *models.UpdateMessageRequest) (*models.Message, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	message, err := s.messageRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if message.UserID != userID {
		return nil, fmt.Errorf("%w: you can only edit your own messages", pkg.ErrForbidden)
	}

	if req.EncryptionVersion == 1 {
		message.Ciphertext = req.Ciphertext
		message.SenderDeviceID = req.SenderDeviceID
		message.E2EEMetadata = req.E2EEMetadata
		message.Content = nil
	} else {
		message.Content = &req.Content
	}

	if err := s.messageRepo.Update(ctx, message); err != nil {
		return nil, err
	}

	attachments, err := s.attachmentRepo.GetByMessageID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get attachments: %w", err)
	}
	message.Attachments = attachments
	if message.Attachments == nil {
		message.Attachments = []models.Attachment{}
	}

	// Re-parse mentions (server can't read E2EE content)
	if req.EncryptionVersion == 0 {
		channel, _ := s.channelRepo.GetByID(ctx, message.ChannelID)
		serverID := ""
		if channel != nil {
			serverID = channel.ServerID
		}

		if err := s.mentionRepo.DeleteByMessageID(ctx, id); err != nil {
			fmt.Printf("[mention] failed to delete old mentions for message %s: %v\n", id, err)
		}
		mentionedIDs := s.extractMentions(ctx, req.Content)
		if len(mentionedIDs) > 0 {
			if err := s.mentionRepo.SaveMentions(ctx, id, mentionedIDs); err != nil {
				fmt.Printf("[mention] failed to save mentions for message %s: %v\n", id, err)
			}
		}
		message.Mentions = mentionedIDs

		if err := s.roleMentionRepo.DeleteByMessageID(ctx, id); err != nil {
			fmt.Printf("[mention] failed to delete old role mentions for message %s: %v\n", id, err)
		}
		roleMentionIDs := s.extractRoleMentions(ctx, req.Content, serverID)
		if len(roleMentionIDs) > 0 {
			if err := s.roleMentionRepo.SaveRoleMentions(ctx, id, roleMentionIDs); err != nil {
				fmt.Printf("[mention] failed to save role mentions for message %s: %v\n", id, err)
			}
		}
		message.RoleMentions = roleMentionIDs
	} else {
		message.Mentions = []string{}
		message.RoleMentions = []string{}
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpMessageUpdate,
		Data: message,
	})

	return message, nil
}

// Delete deletes a message. Owner or MANAGE_MESSAGES permission required.
func (s *messageService) Delete(ctx context.Context, id string, userID string, userPermissions models.Permission) error {
	message, err := s.messageRepo.GetByID(ctx, id)
	if err != nil {
		return err
	}

	if message.UserID != userID && !userPermissions.Has(models.PermManageMessages) {
		return fmt.Errorf("%w: you can only delete your own messages", pkg.ErrForbidden)
	}

	if err := s.messageRepo.Delete(ctx, id); err != nil {
		return err
	}

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpMessageDelete,
		Data: map[string]string{
			"id":         id,
			"channel_id": message.ChannelID,
		},
	})

	return nil
}

// extractRoleMentions parses @rolename patterns from content and returns mentionable role IDs.
// Roles are matched case-insensitively within the given server.
func (s *messageService) extractRoleMentions(ctx context.Context, content string, serverID string) []string {
	if serverID == "" {
		return []string{}
	}

	matches := mentionRegex.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return []string{}
	}

	// Load all server roles once (cached per request)
	roles, err := s.roleRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return []string{}
	}

	// Build name→role lookup (lowercase)
	roleByName := make(map[string]*models.Role, len(roles))
	for i := range roles {
		roleByName[strings.ToLower(roles[i].Name)] = &roles[i]
	}

	seen := make(map[string]bool)
	var roleIDs []string

	for _, match := range matches {
		name := strings.ToLower(match[1])
		if seen[name] {
			continue
		}
		seen[name] = true

		role, ok := roleByName[name]
		if !ok || !role.Mentionable {
			continue
		}
		roleIDs = append(roleIDs, role.ID)
	}

	if roleIDs == nil {
		roleIDs = []string{}
	}
	return roleIDs
}

// extractMentions parses @username patterns from content and returns valid user IDs.
// Deduplicates results; silently skips unknown usernames.
func (s *messageService) extractMentions(ctx context.Context, content string) []string {
	matches := mentionRegex.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return []string{}
	}

	seen := make(map[string]bool)
	var userIDs []string

	for _, match := range matches {
		username := strings.ToLower(match[1])
		if seen[username] {
			continue
		}
		seen[username] = true

		user, err := s.userRepo.GetByUsername(ctx, username)
		if err != nil {
			continue
		}
		userIDs = append(userIDs, user.ID)
	}

	if userIDs == nil {
		userIDs = []string{}
	}
	return userIDs
}
