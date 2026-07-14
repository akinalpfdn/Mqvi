package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// PushTokenService manages registration of device push notification tokens.
type PushTokenService interface {
	RegisterToken(ctx context.Context, userID string, req *models.RegisterPushTokenRequest) (*models.PushToken, error)
	UnregisterToken(ctx context.Context, userID, token string) error
	ListUserTokens(ctx context.Context, userID string) ([]models.PushToken, error)
}

type pushTokenService struct {
	repo repository.PushTokenRepository
}

func NewPushTokenService(repo repository.PushTokenRepository) PushTokenService {
	return &pushTokenService{repo: repo}
}

func (s *pushTokenService) RegisterToken(ctx context.Context, userID string, req *models.RegisterPushTokenRequest) (*models.PushToken, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	tokenType := req.TokenType
	if tokenType == "" {
		tokenType = models.PushTokenTypeFCM
	}
	t := &models.PushToken{
		UserID:    userID,
		Token:     req.Token,
		Platform:  req.Platform,
		TokenType: tokenType,
	}
	if req.DeviceLabel != "" {
		t.DeviceLabel = &req.DeviceLabel
	}
	// Empty for clients that predate the device chain — the server then addresses the whole user.
	if req.DeviceID != "" {
		t.DeviceID = &req.DeviceID
	}

	if err := s.repo.Upsert(ctx, t); err != nil {
		return nil, fmt.Errorf("failed to register push token: %w", err)
	}
	return t, nil
}

func (s *pushTokenService) UnregisterToken(ctx context.Context, userID, token string) error {
	if token == "" {
		return fmt.Errorf("%w: token is required", pkg.ErrBadRequest)
	}
	if err := s.repo.Delete(ctx, userID, token); err != nil {
		return fmt.Errorf("failed to unregister push token: %w", err)
	}
	return nil
}

func (s *pushTokenService) ListUserTokens(ctx context.Context, userID string) ([]models.PushToken, error) {
	tokens, err := s.repo.ListByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list push tokens: %w", err)
	}
	if tokens == nil {
		tokens = []models.PushToken{}
	}
	return tokens, nil
}
