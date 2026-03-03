// Package repository — ReportRepository SQLite implementasyonu.
//
// reports tablosu CRUD işlemleri.
// Admin panelinden listeleme: JOIN ile raporlayan/raporlanan kullanıcı bilgileri dahil edilir.
// HasPendingReport: aynı reporter→target çiftinde mükerrer rapor önleme.
package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// sqliteReportRepo, ReportRepository interface'inin SQLite implementasyonu.
type sqliteReportRepo struct {
	db database.TxQuerier
}

// NewSQLiteReportRepo, constructor — interface döner.
func NewSQLiteReportRepo(db database.TxQuerier) ReportRepository {
	return &sqliteReportRepo{db: db}
}

// Create, yeni rapor oluşturur.
// ID ve CreatedAt SQLite tarafından otomatik atanır (RETURNING ile okunur).
func (r *sqliteReportRepo) Create(ctx context.Context, report *models.Report) error {
	query := `
		INSERT INTO reports (id, reporter_id, reported_user_id, reason, description)
		VALUES (?, ?, ?, ?, ?)
		RETURNING created_at`

	err := r.db.QueryRowContext(ctx, query,
		report.ID, report.ReporterID, report.ReportedUserID,
		report.Reason, report.Description,
	).Scan(&report.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create report: %w", err)
	}
	return nil
}

// GetByID, ID ile rapor döner.
func (r *sqliteReportRepo) GetByID(ctx context.Context, id string) (*models.Report, error) {
	query := `
		SELECT id, reporter_id, reported_user_id, reason, description,
		       status, resolved_by, resolved_at, created_at
		FROM reports WHERE id = ?`

	var report models.Report
	var resolvedBy sql.NullString
	var resolvedAt sql.NullString

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&report.ID, &report.ReporterID, &report.ReportedUserID,
		&report.Reason, &report.Description,
		&report.Status, &resolvedBy, &resolvedAt, &report.CreatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: report %s", pkg.ErrNotFound, id)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get report: %w", err)
	}

	if resolvedBy.Valid {
		report.ResolvedBy = &resolvedBy.String
	}
	if resolvedAt.Valid {
		report.ResolvedAt = &resolvedAt.String
	}

	return &report, nil
}

// ListPending, bekleyen raporları sayfalanmış döner.
// JOIN ile raporlayan ve raporlanan kullanıcı bilgileri dahil edilir.
// İkinci return değeri toplam kayıt sayısıdır (pagination hesaplaması için).
func (r *sqliteReportRepo) ListPending(ctx context.Context, limit, offset int) ([]models.ReportWithUsers, int, error) {
	return r.listByStatus(ctx, models.ReportStatusPending, limit, offset)
}

// ListAll, tüm raporları sayfalanmış döner.
func (r *sqliteReportRepo) ListAll(ctx context.Context, limit, offset int) ([]models.ReportWithUsers, int, error) {
	return r.listByStatus(ctx, "", limit, offset)
}

// listByStatus, ortak listeleme mantığı. status boş string ise tüm raporlar döner.
func (r *sqliteReportRepo) listByStatus(ctx context.Context, status models.ReportStatus, limit, offset int) ([]models.ReportWithUsers, int, error) {
	// Limit/offset koruma
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	// 1. Toplam kayıt sayısı
	var countQuery string
	var countArgs []any

	if status != "" {
		countQuery = `SELECT COUNT(*) FROM reports WHERE status = ?`
		countArgs = []any{status}
	} else {
		countQuery = `SELECT COUNT(*) FROM reports`
	}

	var totalCount int
	if err := r.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("failed to count reports: %w", err)
	}

	if totalCount == 0 {
		return []models.ReportWithUsers{}, 0, nil
	}

	// 2. Sayfalanmış sonuçlar
	baseQuery := `
		SELECT r.id, r.reporter_id, r.reported_user_id, r.reason, r.description,
		       r.status, r.resolved_by, r.resolved_at, r.created_at,
		       reporter.username, reporter.display_name,
		       reported.username, reported.display_name
		FROM reports r
		JOIN users reporter ON reporter.id = r.reporter_id
		JOIN users reported ON reported.id = r.reported_user_id`

	var dataQuery string
	var dataArgs []any

	if status != "" {
		dataQuery = baseQuery + `
		WHERE r.status = ?
		ORDER BY r.created_at DESC
		LIMIT ? OFFSET ?`
		dataArgs = []any{status, limit, offset}
	} else {
		dataQuery = baseQuery + `
		ORDER BY r.created_at DESC
		LIMIT ? OFFSET ?`
		dataArgs = []any{limit, offset}
	}

	rows, err := r.db.QueryContext(ctx, dataQuery, dataArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list reports: %w", err)
	}
	defer rows.Close()

	var reports []models.ReportWithUsers
	for rows.Next() {
		var rw models.ReportWithUsers
		var resolvedBy sql.NullString
		var resolvedAt sql.NullString
		var reporterDisplay, reportedDisplay sql.NullString

		if err := rows.Scan(
			&rw.ID, &rw.ReporterID, &rw.ReportedUserID, &rw.Reason, &rw.Description,
			&rw.Status, &resolvedBy, &resolvedAt, &rw.CreatedAt,
			&rw.ReporterUsername, &reporterDisplay,
			&rw.ReportedUsername, &reportedDisplay,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan report row: %w", err)
		}

		if resolvedBy.Valid {
			rw.ResolvedBy = &resolvedBy.String
		}
		if resolvedAt.Valid {
			rw.ResolvedAt = &resolvedAt.String
		}
		if reporterDisplay.Valid {
			rw.ReporterDisplay = &reporterDisplay.String
		}
		if reportedDisplay.Valid {
			rw.ReportedDisplay = &reportedDisplay.String
		}

		reports = append(reports, rw)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating report rows: %w", err)
	}

	if reports == nil {
		reports = []models.ReportWithUsers{}
	}
	return reports, totalCount, nil
}

// UpdateStatus, rapor durumunu günceller (pending → reviewed/resolved/dismissed).
// resolvedBy parametresi admin user ID'sidir.
// resolved_at SQLite datetime string olarak kaydedilir (TEXT column).
func (r *sqliteReportRepo) UpdateStatus(ctx context.Context, id string, status models.ReportStatus, resolvedBy string) error {
	query := `
		UPDATE reports
		SET status = ?, resolved_by = ?, resolved_at = datetime('now')
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, status, resolvedBy, id)
	if err != nil {
		return fmt.Errorf("failed to update report status: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: report %s", pkg.ErrNotFound, id)
	}
	return nil
}

// HasPendingReport, reporter→target çiftinde aktif (pending) rapor var mı kontrol eder.
// Mükerrer rapor önleme için kullanılır — aynı kullanıcı aynı kişiyi
// zaten pending raporlamışsa yeni rapor oluşturulmaz.
func (r *sqliteReportRepo) HasPendingReport(ctx context.Context, reporterID, targetID string) (bool, error) {
	query := `
		SELECT EXISTS(
			SELECT 1 FROM reports
			WHERE reporter_id = ? AND reported_user_id = ? AND status = 'pending'
		)`

	var exists bool
	if err := r.db.QueryRowContext(ctx, query, reporterID, targetID).Scan(&exists); err != nil {
		return false, fmt.Errorf("failed to check pending report: %w", err)
	}
	return exists, nil
}

// CreateAttachment, rapora delil dosyası ekler.
// ID otomatik atanır (RETURNING ile okunur).
func (r *sqliteReportRepo) CreateAttachment(ctx context.Context, att *models.ReportAttachment) error {
	query := `
		INSERT INTO report_attachments (report_id, filename, file_url, file_size, mime_type)
		VALUES (?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		att.ReportID, att.Filename, att.FileURL, att.FileSize, att.MimeType,
	).Scan(&att.ID, &att.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create report attachment: %w", err)
	}
	return nil
}

// GetAttachmentsByReportID, rapora ait tüm delil dosyalarını döner.
func (r *sqliteReportRepo) GetAttachmentsByReportID(ctx context.Context, reportID string) ([]models.ReportAttachment, error) {
	query := `
		SELECT id, report_id, filename, file_url, file_size, mime_type, created_at
		FROM report_attachments
		WHERE report_id = ?
		ORDER BY created_at`

	rows, err := r.db.QueryContext(ctx, query, reportID)
	if err != nil {
		return nil, fmt.Errorf("failed to get report attachments: %w", err)
	}
	defer rows.Close()

	var attachments []models.ReportAttachment
	for rows.Next() {
		var a models.ReportAttachment
		if err := rows.Scan(&a.ID, &a.ReportID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan report attachment: %w", err)
		}
		attachments = append(attachments, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating report attachments: %w", err)
	}

	if attachments == nil {
		attachments = []models.ReportAttachment{}
	}
	return attachments, nil
}
