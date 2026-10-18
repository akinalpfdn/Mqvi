package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// SessionService backs the active-devices screen: list a user's signed-in devices and sign them
// out remotely.
type SessionService interface {
	List(ctx context.Context, userID, currentSessionID string) ([]models.SessionView, error)
	// Revoke signs out one of the user's other devices. The current one signs out via logout.
	Revoke(ctx context.Context, userID, currentSessionID, targetSessionID string) error
	// RevokeOthers signs out every device but the current one and returns how many it ended.
	RevokeOthers(ctx context.Context, userID, currentSessionID string) (int, error)
}

// SessionRevoker reaches the connections of a revoked session. ISP — the hub's one concern here.
type SessionRevoker interface {
	RevokeAuthSessions(userID string, authSessionIDs []string)
	RevokeAuthSessionsExcept(userID string, keep ...string)
}

type sessionService struct {
	repo    repository.SessionRepository
	revoker SessionRevoker
}

func NewSessionService(repo repository.SessionRepository, revoker SessionRevoker) SessionService {
	return &sessionService{repo: repo, revoker: revoker}
}

func (s *sessionService) List(ctx context.Context, userID, currentSessionID string) ([]models.SessionView, error) {
	sessions, err := s.repo.ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	views := make([]models.SessionView, 0, len(sessions))
	for _, session := range sessions {
		lastActive := session.CreatedAt
		if session.RotatedAt != nil {
			lastActive = *session.RotatedAt
		}
		views = append(views, models.SessionView{
			ID:          session.ID,
			Platform:    session.Client.Platform,
			DeviceLabel: session.Client.DeviceLabel,
			IP:          session.Client.IP,
			City:        session.Client.City,
			Country:     session.Client.Country,
			CreatedAt:   session.CreatedAt,
			LastActive:  lastActive,
			IsCurrent:   session.ID == currentSessionID,
		})
	}
	return views, nil
}

func (s *sessionService) Revoke(ctx context.Context, userID, currentSessionID, targetSessionID string) error {
	if targetSessionID == currentSessionID {
		return fmt.Errorf("%w: use logout to sign out this device", pkg.ErrBadRequest)
	}
	found, err := s.repo.DeleteForUser(ctx, targetSessionID, userID)
	if err != nil {
		return err
	}
	if !found {
		// Same answer for "not yours" and "does not exist": nothing about other users leaks.
		return fmt.Errorf("%w: session not found", pkg.ErrNotFound)
	}
	s.revoker.RevokeAuthSessions(userID, []string{targetSessionID})
	return nil
}

func (s *sessionService) RevokeOthers(ctx context.Context, userID, currentSessionID string) (int, error) {
	// A token issued before sessions were named carries no sid; "every other device" would then
	// include this one. The client refreshes first, which names it.
	if currentSessionID == "" {
		return 0, fmt.Errorf("%w: refresh the session before signing out other devices", pkg.ErrBadRequest)
	}
	ids, err := s.repo.DeleteOthersForUser(ctx, userID, currentSessionID)
	if err != nil {
		return 0, err
	}
	// Except, not by id: connections from pre-sid tokens have no session to match and must go too.
	s.revoker.RevokeAuthSessionsExcept(userID, currentSessionID)
	return len(ids), nil
}
