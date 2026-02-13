// Package repository — ServerRepository'nin SQLite implementasyonu.
//
// Tek sunucu mimarisi: DB'de her zaman tek bir server kaydı vardır.
// Get() tüm tabloyu tarar (tek satır), Update() o satırı günceller.
package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteServerRepo struct {
	db *sql.DB
}

// NewSQLiteServerRepo, constructor.
func NewSQLiteServerRepo(db *sql.DB) ServerRepository {
	return &sqliteServerRepo{db: db}
}

// Get, sunucu bilgisini döner.
// LIMIT 1 ile ilk (ve tek) satırı alır.
func (r *sqliteServerRepo) Get(ctx context.Context) (*models.Server, error) {
	query := `SELECT id, name, icon_url, created_at FROM server LIMIT 1`

	server := &models.Server{}
	err := r.db.QueryRowContext(ctx, query).Scan(
		&server.ID, &server.Name, &server.IconURL, &server.CreatedAt,
	)

	if err != nil {
		return nil, fmt.Errorf("failed to get server: %w", err)
	}

	return server, nil
}

// Update, sunucu bilgisini günceller.
func (r *sqliteServerRepo) Update(ctx context.Context, server *models.Server) error {
	query := `UPDATE server SET name = ?, icon_url = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, server.Name, server.IconURL, server.ID)
	if err != nil {
		return fmt.Errorf("failed to update server: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}
