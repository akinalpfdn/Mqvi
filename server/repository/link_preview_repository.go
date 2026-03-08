// Package repository — LinkPreviewRepository, URL-based OG metadata cache.
// Deduplicated: same URL is not re-fetched until TTL expires. Error flag marks failed fetches.
package repository

import (
	"context"
	"database/sql"
	"time"

	"github.com/akinalp/mqvi/models"
)

// LinkPreviewRepository defines data access for link preview cache.
type LinkPreviewRepository interface {
	// GetByURL returns the cached preview for a URL. Returns nil (no error) if not found.
	GetByURL(ctx context.Context, url string) (*models.LinkPreview, error)
	Upsert(ctx context.Context, preview *models.LinkPreview) error
	// DeleteExpired removes records older than the given time. Returns deleted row count.
	DeleteExpired(ctx context.Context, olderThan time.Time) (int64, error)
}

type sqliteLinkPreviewRepo struct {
	db *sql.DB
}

func NewSQLiteLinkPreviewRepo(db *sql.DB) LinkPreviewRepository {
	return &sqliteLinkPreviewRepo{db: db}
}

func (r *sqliteLinkPreviewRepo) GetByURL(ctx context.Context, url string) (*models.LinkPreview, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT url, title, description, image_url, site_name, favicon_url, fetched_at, error
		FROM link_previews WHERE url = ?
	`, url)

	var lp models.LinkPreview
	var errFlag int
	err := row.Scan(
		&lp.URL, &lp.Title, &lp.Description,
		&lp.ImageURL, &lp.SiteName, &lp.FaviconURL,
		&lp.FetchedAt, &errFlag,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	lp.Error = errFlag == 1
	return &lp, nil
}

func (r *sqliteLinkPreviewRepo) Upsert(ctx context.Context, preview *models.LinkPreview) error {
	errFlag := 0
	if preview.Error {
		errFlag = 1
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO link_previews (url, title, description, image_url, site_name, favicon_url, fetched_at, error)
		VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
		ON CONFLICT(url) DO UPDATE SET
			title = excluded.title,
			description = excluded.description,
			image_url = excluded.image_url,
			site_name = excluded.site_name,
			favicon_url = excluded.favicon_url,
			fetched_at = excluded.fetched_at,
			error = excluded.error
	`, preview.URL, preview.Title, preview.Description,
		preview.ImageURL, preview.SiteName, preview.FaviconURL, errFlag)
	return err
}

func (r *sqliteLinkPreviewRepo) DeleteExpired(ctx context.Context, olderThan time.Time) (int64, error) {
	result, err := r.db.ExecContext(ctx, `
		DELETE FROM link_previews WHERE fetched_at < ?
	`, olderThan.UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
