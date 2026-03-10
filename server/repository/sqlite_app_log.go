package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteAppLogRepo struct {
	db database.TxQuerier
}

func NewSQLiteAppLogRepo(db database.TxQuerier) AppLogRepository {
	return &sqliteAppLogRepo{db: db}
}

func (r *sqliteAppLogRepo) Insert(ctx context.Context, entry *models.AppLog) error {
	query := `
		INSERT INTO app_logs (level, category, user_id, server_id, message, metadata)
		VALUES (?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		entry.Level, entry.Category,
		entry.UserID, entry.ServerID,
		entry.Message, entry.Metadata,
	)
	if err != nil {
		return fmt.Errorf("insert app log: %w", err)
	}
	return nil
}

func (r *sqliteAppLogRepo) List(ctx context.Context, filter models.AppLogFilter) ([]models.AppLog, int, error) {
	var conditions []string
	var args []interface{}

	if filter.Level != "" {
		conditions = append(conditions, "level = ?")
		args = append(args, filter.Level)
	}
	if filter.Category != "" {
		conditions = append(conditions, "category = ?")
		args = append(args, filter.Category)
	}
	if filter.Search != "" {
		conditions = append(conditions, "message LIKE ?")
		args = append(args, "%"+filter.Search+"%")
	}

	where := ""
	if len(conditions) > 0 {
		where = " WHERE " + strings.Join(conditions, " AND ")
	}

	// Count total
	countQuery := "SELECT COUNT(*) FROM app_logs" + where
	var total int
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count app logs: %w", err)
	}

	// Fetch page
	limit := filter.Limit
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	query := "SELECT id, level, category, user_id, server_id, message, metadata, created_at FROM app_logs" +
		where + " ORDER BY created_at DESC LIMIT ? OFFSET ?"

	pageArgs := append(args, limit, offset)
	rows, err := r.db.QueryContext(ctx, query, pageArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("list app logs: %w", err)
	}
	defer rows.Close()

	var logs []models.AppLog
	for rows.Next() {
		var l models.AppLog
		if err := rows.Scan(&l.ID, &l.Level, &l.Category, &l.UserID, &l.ServerID, &l.Message, &l.Metadata, &l.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("scan app log: %w", err)
		}
		logs = append(logs, l)
	}

	return logs, total, nil
}

func (r *sqliteAppLogRepo) DeleteBefore(ctx context.Context, before string) (int64, error) {
	res, err := r.db.ExecContext(ctx, "DELETE FROM app_logs WHERE created_at < ?", before)
	if err != nil {
		return 0, fmt.Errorf("delete old app logs: %w", err)
	}
	return res.RowsAffected()
}

func (r *sqliteAppLogRepo) DeleteAll(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM app_logs")
	if err != nil {
		return fmt.Errorf("clear app logs: %w", err)
	}
	return nil
}
