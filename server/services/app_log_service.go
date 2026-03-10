package services

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// AppLogService writes and queries structured app logs.
type AppLogService interface {
	// Log writes a log entry asynchronously (non-blocking).
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
	// List returns paginated, filtered log entries.
	List(ctx context.Context, filter models.AppLogFilter) ([]models.AppLog, int, error)
	// Clear deletes all logs.
	Clear(ctx context.Context) error
	// Start begins the async writer goroutine and auto-purge ticker.
	Start(ctx context.Context)
}

type appLogService struct {
	repo repository.AppLogRepository
	ch   chan models.AppLog
}

// NewAppLogService creates the service. Call Start() to begin async writing.
func NewAppLogService(repo repository.AppLogRepository) AppLogService {
	return &appLogService{
		repo: repo,
		ch:   make(chan models.AppLog, 256),
	}
}

func (s *appLogService) Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string) {
	metaJSON := "{}"
	if metadata != nil {
		if b, err := json.Marshal(metadata); err == nil {
			metaJSON = string(b)
		}
	}

	entry := models.AppLog{
		Level:    level,
		Category: category,
		UserID:   userID,
		ServerID: serverID,
		Message:  message,
		Metadata: metaJSON,
	}

	// Non-blocking send — drop if buffer full (prevents backpressure on hot paths)
	select {
	case s.ch <- entry:
	default:
		log.Printf("[app_log] buffer full, dropping log: %s", message)
	}
}

func (s *appLogService) List(ctx context.Context, filter models.AppLogFilter) ([]models.AppLog, int, error) {
	return s.repo.List(ctx, filter)
}

func (s *appLogService) Clear(ctx context.Context) error {
	return s.repo.DeleteAll(ctx)
}

// Start runs the async writer and daily auto-purge (30 days).
func (s *appLogService) Start(ctx context.Context) {
	// Writer goroutine — drains channel and writes to DB
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case entry := <-s.ch:
				if err := s.repo.Insert(context.Background(), &entry); err != nil {
					log.Printf("[app_log] failed to write: %v", err)
				}
			}
		}
	}()

	// Auto-purge: delete logs older than 30 days, check every 6 hours
	go func() {
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cutoff := time.Now().AddDate(0, 0, -30).UTC().Format("2006-01-02 15:04:05")
				deleted, err := s.repo.DeleteBefore(context.Background(), cutoff)
				if err != nil {
					log.Printf("[app_log] auto-purge error: %v", err)
				} else if deleted > 0 {
					log.Printf("[app_log] auto-purge: deleted %d logs older than 30 days", deleted)
				}
			}
		}
	}()
}
