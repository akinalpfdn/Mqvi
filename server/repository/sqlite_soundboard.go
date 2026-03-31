package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/google/uuid"
)

type sqliteSoundboardRepo struct {
	db *sql.DB
}

func NewSQLiteSoundboardRepo(db *sql.DB) SoundboardRepository {
	return &sqliteSoundboardRepo{db: db}
}

func (r *sqliteSoundboardRepo) Create(ctx context.Context, sound *models.SoundboardSound) error {
	if sound.ID == "" {
		sound.ID = uuid.New().String()
	}
	if sound.CreatedAt.IsZero() {
		sound.CreatedAt = time.Now().UTC()
	}

	_, err := r.db.ExecContext(ctx,
		`INSERT INTO soundboard_sounds (id, server_id, name, emoji, file_url, file_size, duration_ms, uploaded_by, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sound.ID, sound.ServerID, sound.Name, sound.Emoji, sound.FileURL,
		sound.FileSize, sound.DurationMs, sound.UploadedBy, sound.CreatedAt.Format(time.RFC3339Nano),
	)
	return err
}

func (r *sqliteSoundboardRepo) GetByID(ctx context.Context, id string) (*models.SoundboardSound, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT s.id, s.server_id, s.name, s.emoji, s.file_url, s.file_size, s.duration_ms, s.uploaded_by, s.created_at,
		        u.username, COALESCE(u.display_name, u.username)
		 FROM soundboard_sounds s
		 JOIN users u ON u.id = s.uploaded_by
		 WHERE s.id = ?`, id)

	var s models.SoundboardSound
	var createdAt string
	err := row.Scan(&s.ID, &s.ServerID, &s.Name, &s.Emoji, &s.FileURL, &s.FileSize,
		&s.DurationMs, &s.UploadedBy, &createdAt, &s.UploaderUsername, &s.UploaderDisplayName)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: sound not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, err
	}
	s.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return &s, nil
}

func (r *sqliteSoundboardRepo) ListByServer(ctx context.Context, serverID string) ([]models.SoundboardSound, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT s.id, s.server_id, s.name, s.emoji, s.file_url, s.file_size, s.duration_ms, s.uploaded_by, s.created_at,
		        u.username, COALESCE(u.display_name, u.username)
		 FROM soundboard_sounds s
		 JOIN users u ON u.id = s.uploaded_by
		 WHERE s.server_id = ?
		 ORDER BY s.name ASC`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sounds []models.SoundboardSound
	for rows.Next() {
		var s models.SoundboardSound
		var createdAt string
		if err := rows.Scan(&s.ID, &s.ServerID, &s.Name, &s.Emoji, &s.FileURL, &s.FileSize,
			&s.DurationMs, &s.UploadedBy, &createdAt, &s.UploaderUsername, &s.UploaderDisplayName); err != nil {
			return nil, err
		}
		s.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		sounds = append(sounds, s)
	}
	return sounds, rows.Err()
}

func (r *sqliteSoundboardRepo) Update(ctx context.Context, sound *models.SoundboardSound) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE soundboard_sounds SET name = ?, emoji = ? WHERE id = ?`,
		sound.Name, sound.Emoji, sound.ID)
	return err
}

func (r *sqliteSoundboardRepo) Delete(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM soundboard_sounds WHERE id = ?`, id)
	return err
}

func (r *sqliteSoundboardRepo) CountByServer(ctx context.Context, serverID string) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = ?`, serverID).Scan(&count)
	return count, err
}
