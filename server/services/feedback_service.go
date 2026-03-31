package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/google/uuid"
)

type FeedbackService interface {
	CreateTicket(ctx context.Context, userID string, req *models.CreateFeedbackRequest) (*models.FeedbackTicket, error)
	GetTicketByID(ctx context.Context, id, userID string, isAdmin bool) (*models.FeedbackTicketWithUser, []models.FeedbackReplyWithUser, error)
	ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	ListAll(ctx context.Context, status, ticketType string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	AddReply(ctx context.Context, ticketID, userID string, isAdmin bool, req *models.CreateFeedbackReplyRequest) (*models.FeedbackReply, error)
	UpdateStatus(ctx context.Context, ticketID string, req *models.UpdateFeedbackStatusRequest) error
}

type feedbackService struct {
	feedbackRepo repository.FeedbackRepository
}

func NewFeedbackService(feedbackRepo repository.FeedbackRepository) FeedbackService {
	return &feedbackService{feedbackRepo: feedbackRepo}
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

	return ticket, nil
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

	replies, err := s.feedbackRepo.GetRepliesByTicketID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	return ticket, replies, nil
}

func (s *feedbackService) ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	return s.feedbackRepo.ListByUser(ctx, userID, limit, offset)
}

func (s *feedbackService) ListAll(ctx context.Context, status, ticketType string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	return s.feedbackRepo.ListAll(ctx, status, ticketType, limit, offset)
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

func (s *feedbackService) UpdateStatus(ctx context.Context, ticketID string, req *models.UpdateFeedbackStatusRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	return s.feedbackRepo.UpdateStatus(ctx, ticketID, models.FeedbackStatus(req.Status))
}
