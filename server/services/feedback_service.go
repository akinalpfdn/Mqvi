package services

import (
	"context"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/repository"
	"github.com/google/uuid"
)

type FeedbackService interface {
	CreateTicket(ctx context.Context, userID string, req *models.CreateFeedbackRequest) (*models.FeedbackTicket, error)
	GetTicketByID(ctx context.Context, id, userID string, isAdmin bool) (*models.FeedbackTicketWithUser, []models.FeedbackReplyWithUser, error)
	ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	ListAllForAdmin(ctx context.Context, statuses, types []string, sortKey, sortDir, adminID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	AddReply(ctx context.Context, ticketID, userID string, isAdmin bool, req *models.CreateFeedbackReplyRequest) (*models.FeedbackReply, error)
	UpdateStatus(ctx context.Context, ticketID string, req *models.UpdateFeedbackStatusRequest) error
	DeleteTicket(ctx context.Context, id, userID string) error
}

type feedbackService struct {
	feedbackRepo   repository.FeedbackRepository
	userRepo       repository.UserRepository
	fileDeleter    FileDeleter
	storageService StorageService
	emailSender    email.EmailSender
}

func NewFeedbackService(
	feedbackRepo repository.FeedbackRepository,
	userRepo repository.UserRepository,
	fileDeleter FileDeleter,
	storageService StorageService,
	emailSender email.EmailSender,
) FeedbackService {
	return &feedbackService{
		feedbackRepo:   feedbackRepo,
		userRepo:       userRepo,
		fileDeleter:    fileDeleter,
		storageService: storageService,
		emailSender:    emailSender,
	}
}

func (s *feedbackService) CreateTicket(ctx context.Context, userID string, req *models.CreateFeedbackRequest) (*models.FeedbackTicket, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	ticket := &models.FeedbackTicket{
		ID:      uuid.New().String(),
		UserID:  userID,
		Type:    models.FeedbackType(req.Type),
		Subject: req.Subject,
		Content: req.Content,
		Status:  models.FeedbackStatusOpen,
	}

	if err := s.feedbackRepo.CreateTicket(ctx, ticket); err != nil {
		return nil, err
	}

	// Re-read to get server-generated timestamps
	created, err := s.feedbackRepo.GetTicketByID(ctx, ticket.ID)
	if err != nil {
		return nil, err
	}
	ticket.CreatedAt = created.CreatedAt
	ticket.UpdatedAt = created.UpdatedAt

	s.notifyAdmins(ticket, created.Username)

	return ticket, nil
}

// notifyAdmins fires off admin notification emails in a detached goroutine.
// The ticket has already been persisted; email failures should never block
// the user response or leak into the request lifecycle.
func (s *feedbackService) notifyAdmins(ticket *models.FeedbackTicket, fromUsername string) {
	if s.emailSender == nil || s.userRepo == nil {
		return
	}
	go func() {
		bg := context.Background()
		emails, err := s.userRepo.ListPlatformAdminEmails(bg)
		if err != nil {
			log.Printf("[feedback] list admin emails: %v", err)
			return
		}
		for _, addr := range emails {
			if err := s.emailSender.SendNewFeedbackNotification(bg, addr, string(ticket.Type), ticket.Subject, fromUsername); err != nil {
				log.Printf("[feedback] notify admin %s: %v", addr, err)
			}
		}
	}()
}

func (s *feedbackService) GetTicketByID(ctx context.Context, id, userID string, isAdmin bool) (*models.FeedbackTicketWithUser, []models.FeedbackReplyWithUser, error) {
	ticket, err := s.feedbackRepo.GetTicketByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	// Non-admin users can only view their own tickets
	if !isAdmin && ticket.UserID != userID {
		return nil, nil, fmt.Errorf("%w: you can only view your own feedback", pkg.ErrForbidden)
	}

	// An admin opening a ticket clears its per-admin unread dot. Best-effort:
	// read-tracking is a convenience, not auth state, and self-heals on next open.
	if isAdmin && userID != "" {
		if err := s.feedbackRepo.MarkTicketSeen(ctx, userID, id); err != nil {
			log.Printf("[feedback] mark ticket seen admin=%s ticket=%s: %v", userID, id, err)
		}
	}

	replies, err := s.feedbackRepo.GetRepliesByTicketID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	allAtts, _ := s.feedbackRepo.GetAttachmentsByTicketID(ctx, id)

	// Separate ticket-level vs reply-level attachments
	for i := range allAtts {
		if allAtts[i].ReplyID == nil {
			ticket.Attachments = append(ticket.Attachments, allAtts[i])
		} else {
			for j := range replies {
				if replies[j].ID == *allAtts[i].ReplyID {
					replies[j].Attachments = append(replies[j].Attachments, allAtts[i])
					break
				}
			}
		}
	}

	return ticket, replies, nil
}

func (s *feedbackService) ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	return s.feedbackRepo.ListByUser(ctx, userID, limit, offset)
}

func (s *feedbackService) ListAllForAdmin(ctx context.Context, statuses, types []string, sortKey, sortDir, adminID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	return s.feedbackRepo.ListAllForAdmin(ctx, repository.FeedbackListParams{
		AdminID:  adminID,
		Statuses: filterValidFeedbackStatuses(statuses),
		Types:    filterValidFeedbackTypes(types),
		SortKey:  sortKey,
		SortDir:  sortDir,
		Limit:    limit,
		Offset:   offset,
	})
}

// filterValidFeedbackStatuses / filterValidFeedbackTypes drop any values not in
// the known enum set, so a typo'd filter yields "all" rather than an empty IN(...).
func filterValidFeedbackStatuses(in []string) []string {
	valid := map[string]bool{
		string(models.FeedbackStatusOpen):       true,
		string(models.FeedbackStatusInProgress): true,
		string(models.FeedbackStatusResolved):   true,
		string(models.FeedbackStatusClosed):     true,
	}
	return filterKnown(in, valid)
}

func filterValidFeedbackTypes(in []string) []string {
	valid := map[string]bool{
		string(models.FeedbackTypeBug):        true,
		string(models.FeedbackTypeSuggestion): true,
		string(models.FeedbackTypeQuestion):   true,
		string(models.FeedbackTypeOther):      true,
	}
	return filterKnown(in, valid)
}

func filterKnown(in []string, valid map[string]bool) []string {
	var out []string
	for _, v := range in {
		if valid[v] {
			out = append(out, v)
		}
	}
	return out
}

func (s *feedbackService) AddReply(ctx context.Context, ticketID, userID string, isAdmin bool, req *models.CreateFeedbackReplyRequest) (*models.FeedbackReply, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Verify ticket exists and user has access
	ticket, err := s.feedbackRepo.GetTicketByID(ctx, ticketID)
	if err != nil {
		return nil, err
	}
	if !isAdmin && ticket.UserID != userID {
		return nil, fmt.Errorf("%w: you can only reply to your own feedback", pkg.ErrForbidden)
	}

	reply := &models.FeedbackReply{
		ID:       uuid.New().String(),
		TicketID: ticketID,
		UserID:   userID,
		IsAdmin:  isAdmin,
		Content:  req.Content,
	}

	if err := s.feedbackRepo.CreateReply(ctx, reply); err != nil {
		return nil, err
	}

	return reply, nil
}

func (s *feedbackService) DeleteTicket(ctx context.Context, id, userID string) error {
	ticket, err := s.feedbackRepo.GetTicketByID(ctx, id)
	if err != nil {
		return err
	}
	if ticket.UserID != userID {
		return fmt.Errorf("%w: you can only delete your own feedback", pkg.ErrForbidden)
	}

	// Delete physical files and release quota before CASCADE removes rows
	if atts, err := s.feedbackRepo.GetAttachmentsByTicketID(ctx, id); err == nil {
		var totalBytes int64
		for _, a := range atts {
			s.fileDeleter.DeleteFromURL(a.FileURL)
			if a.FileSize != nil {
				totalBytes += *a.FileSize
			}
		}
		if totalBytes > 0 {
			if err := s.storageService.Release(ctx, userID, totalBytes); err != nil {
				log.Printf("[feedback] failed to release storage quota for user %s: %v", userID, err)
			}
		}
	}

	return s.feedbackRepo.DeleteTicket(ctx, id)
}

func (s *feedbackService) UpdateStatus(ctx context.Context, ticketID string, req *models.UpdateFeedbackStatusRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	return s.feedbackRepo.UpdateStatus(ctx, ticketID, models.FeedbackStatus(req.Status))
}
