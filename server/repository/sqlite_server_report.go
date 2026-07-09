package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteServerReportRepo struct {
	db database.TxQuerier
}

func NewSQLiteServerReportRepo(db database.TxQuerier) ServerReportRepository {
	return &sqliteServerReportRepo{db: db}
}

func (r *sqliteServerReportRepo) Create(ctx context.Context, report *models.ServerReport) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO server_reports (id, reporter_id, server_id, reason, description, status)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		report.ID, report.ReporterID, report.ServerID, report.Reason, report.Description, report.Status,
	)
	if err != nil {
		return fmt.Errorf("failed to create server report: %w", err)
	}
	return nil
}

func (r *sqliteServerReportRepo) HasPending(ctx context.Context, reporterID, serverID string) (bool, error) {
	var one int
	err := r.db.QueryRowContext(ctx,
		`SELECT 1 FROM server_reports WHERE reporter_id = ? AND server_id = ? AND status = 'pending' LIMIT 1`,
		reporterID, serverID,
	).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check pending server report: %w", err)
	}
	return true, nil
}

func (r *sqliteServerReportRepo) ListForAdmin(ctx context.Context, status string, limit, offset int) ([]models.ServerReportWithInfo, int, error) {
	where := ""
	var args []any
	if status == string(models.ReportStatusPending) {
		where = "WHERE sr.status = 'pending'"
	}

	var total int
	if err := r.db.QueryRowContext(ctx,
		fmt.Sprintf("SELECT COUNT(*) FROM server_reports sr %s", where), args...,
	).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("failed to count server reports: %w", err)
	}

	query := fmt.Sprintf(`
		SELECT sr.id, sr.reporter_id, sr.server_id, sr.reason, sr.description, sr.status,
			sr.resolved_by, sr.resolved_at, sr.created_at,
			COALESCE(u.username, ''), COALESCE(s.name, '')
		FROM server_reports sr
		LEFT JOIN users u ON u.id = sr.reporter_id
		LEFT JOIN servers s ON s.id = sr.server_id
		%s
		ORDER BY sr.created_at DESC
		LIMIT ? OFFSET ?`, where)

	rows, err := r.db.QueryContext(ctx, query, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list server reports: %w", err)
	}
	defer rows.Close()

	out := make([]models.ServerReportWithInfo, 0, limit)
	for rows.Next() {
		var it models.ServerReportWithInfo
		if err := rows.Scan(
			&it.ID, &it.ReporterID, &it.ServerID, &it.Reason, &it.Description, &it.Status,
			&it.ResolvedBy, &it.ResolvedAt, &it.CreatedAt,
			&it.ReporterUsername, &it.ServerName,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan server report: %w", err)
		}
		out = append(out, it)
	}
	return out, total, rows.Err()
}

func (r *sqliteServerReportRepo) UpdateStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE server_reports SET status = ?, resolved_by = ?,
			resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		 WHERE id = ?`,
		status, adminID, reportID,
	)
	if err != nil {
		return fmt.Errorf("failed to update server report status: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return pkg.ErrNotFound
	}
	return nil
}
