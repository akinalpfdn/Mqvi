// Package repository — MetricsHistoryRepository'nin SQLite implementasyonu.
package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteMetricsHistoryRepo struct {
	db database.TxQuerier
}

// NewSQLiteMetricsHistoryRepo, constructor — interface döner.
func NewSQLiteMetricsHistoryRepo(db database.TxQuerier) MetricsHistoryRepository {
	return &sqliteMetricsHistoryRepo{db: db}
}

// Insert, yeni bir metrik snapshot'ı kaydeder.
func (r *sqliteMetricsHistoryRepo) Insert(ctx context.Context, snapshot *models.MetricsSnapshot) error {
	query := `
		INSERT INTO livekit_metrics_history (
			instance_id, room_count, participant_count, memory_bytes,
			goroutines, bytes_in, bytes_out, cpu_pct,
			bandwidth_in_bps, bandwidth_out_bps, available
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		snapshot.InstanceID,
		snapshot.RoomCount,
		snapshot.ParticipantCount,
		snapshot.MemoryBytes,
		snapshot.Goroutines,
		snapshot.BytesIn,
		snapshot.BytesOut,
		snapshot.CPUPercent,
		snapshot.BandwidthInBps,
		snapshot.BandwidthOutBps,
		snapshot.Available,
	)
	if err != nil {
		return fmt.Errorf("failed to insert metrics snapshot: %w", err)
	}

	return nil
}

// GetSummary, SQL aggregate ile belirli zaman aralığı için peak/average hesaplar.
// Sadece available=1 kayıtlar dahil edilir (erişilemeyen snapshot'lar hariç).
func (r *sqliteMetricsHistoryRepo) GetSummary(ctx context.Context, instanceID string, period string) (*models.MetricsHistorySummary, error) {
	// Period → SQLite datetime modifier dönüşümü.
	// Raw user input SQL'e gitmez — switch ile whitelist.
	modifier, err := periodToModifier(period)
	if err != nil {
		return nil, err
	}

	query := `
		SELECT
			COUNT(*)                    AS sample_count,
			COALESCE(MAX(participant_count), 0)  AS peak_participants,
			COALESCE(AVG(participant_count), 0)  AS avg_participants,
			COALESCE(MAX(room_count), 0)         AS peak_rooms,
			COALESCE(AVG(room_count), 0)         AS avg_rooms,
			COALESCE(MAX(memory_bytes), 0)       AS peak_memory_bytes,
			COALESCE(AVG(memory_bytes), 0)       AS avg_memory_bytes,
			COALESCE(MAX(cpu_pct), 0)            AS peak_cpu_pct,
			COALESCE(AVG(cpu_pct), 0)            AS avg_cpu_pct,
			COALESCE(MAX(bandwidth_in_bps), 0)   AS peak_bandwidth_in,
			COALESCE(AVG(bandwidth_in_bps), 0)   AS avg_bandwidth_in,
			COALESCE(MAX(bandwidth_out_bps), 0)  AS peak_bandwidth_out,
			COALESCE(AVG(bandwidth_out_bps), 0)  AS avg_bandwidth_out,
			COALESCE(MAX(goroutines), 0)         AS peak_goroutines,
			COALESCE(AVG(goroutines), 0)         AS avg_goroutines
		FROM livekit_metrics_history
		WHERE instance_id = ?
		  AND available = 1
		  AND collected_at >= datetime('now', ?)`

	summary := &models.MetricsHistorySummary{Period: period}

	var avgMemory float64
	err = r.db.QueryRowContext(ctx, query, instanceID, modifier).Scan(
		&summary.SampleCount,
		&summary.PeakParticipants,
		&summary.AvgParticipants,
		&summary.PeakRooms,
		&summary.AvgRooms,
		&summary.PeakMemoryBytes,
		&avgMemory,
		&summary.PeakCPUPercent,
		&summary.AvgCPUPercent,
		&summary.PeakBandwidthIn,
		&summary.AvgBandwidthIn,
		&summary.PeakBandwidthOut,
		&summary.AvgBandwidthOut,
		&summary.PeakGoroutines,
		&summary.AvgGoroutines,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get metrics summary: %w", err)
	}

	summary.AvgMemoryBytes = uint64(avgMemory)

	return summary, nil
}

// GetTimeSeries, chart için zaman serisi verisi döner.
// Period'a göre aggregation uygulanır:
//   - 24h: ham veri (5dk interval → ~288 nokta)
//   - 7d:  saatlik ortalama
//   - 30d: 6 saatlik ortalama
func (r *sqliteMetricsHistoryRepo) GetTimeSeries(ctx context.Context, instanceID string, period string) ([]models.MetricsTimeSeriesPoint, error) {
	modifier, err := periodToModifier(period)
	if err != nil {
		return nil, err
	}

	var query string
	switch period {
	case "24h":
		// Ham veri — aggregation yok
		query = `
			SELECT collected_at, cpu_pct, bandwidth_in_bps, bandwidth_out_bps, participant_count
			FROM livekit_metrics_history
			WHERE instance_id = ? AND available = 1 AND collected_at >= datetime('now', ?)
			ORDER BY collected_at ASC`
	case "7d":
		// Saatlik ortalama
		query = `
			SELECT
				strftime('%Y-%m-%dT%H:00:00', collected_at) AS ts,
				AVG(cpu_pct), AVG(bandwidth_in_bps), AVG(bandwidth_out_bps),
				CAST(AVG(participant_count) AS INTEGER)
			FROM livekit_metrics_history
			WHERE instance_id = ? AND available = 1 AND collected_at >= datetime('now', ?)
			GROUP BY strftime('%Y-%m-%dT%H:00:00', collected_at)
			ORDER BY ts ASC`
	case "30d":
		// 6 saatlik ortalama
		query = `
			SELECT
				strftime('%Y-%m-%dT', collected_at) ||
				printf('%02d', (CAST(strftime('%H', collected_at) AS INTEGER) / 6) * 6) ||
				':00:00' AS ts,
				AVG(cpu_pct), AVG(bandwidth_in_bps), AVG(bandwidth_out_bps),
				CAST(AVG(participant_count) AS INTEGER)
			FROM livekit_metrics_history
			WHERE instance_id = ? AND available = 1 AND collected_at >= datetime('now', ?)
			GROUP BY ts
			ORDER BY ts ASC`
	}

	rows, qErr := r.db.QueryContext(ctx, query, instanceID, modifier)
	if qErr != nil {
		return nil, fmt.Errorf("failed to get metrics time series: %w", qErr)
	}
	defer rows.Close()

	var points []models.MetricsTimeSeriesPoint
	for rows.Next() {
		var p models.MetricsTimeSeriesPoint
		var tsStr string
		if scanErr := rows.Scan(&tsStr, &p.CPUPercent, &p.BandwidthInBps, &p.BandwidthOutBps, &p.Participants); scanErr != nil {
			return nil, fmt.Errorf("failed to scan time series row: %w", scanErr)
		}
		parsed, parseErr := time.Parse("2006-01-02T15:04:05", tsStr)
		if parseErr != nil {
			// collected_at formatı farklı olabilir — fallback dene
			parsed, parseErr = time.Parse("2006-01-02 15:04:05", tsStr)
			if parseErr != nil {
				continue
			}
		}
		p.Timestamp = parsed
		points = append(points, p)
	}

	if rowErr := rows.Err(); rowErr != nil {
		return nil, fmt.Errorf("error iterating time series rows: %w", rowErr)
	}

	return points, nil
}

// PurgeOlderThan, eski metrik kayıtlarını siler.
func (r *sqliteMetricsHistoryRepo) PurgeOlderThan(ctx context.Context, before time.Time) (int64, error) {
	query := `DELETE FROM livekit_metrics_history WHERE collected_at < ?`

	result, err := r.db.ExecContext(ctx, query, before.UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		return 0, fmt.Errorf("failed to purge old metrics: %w", err)
	}

	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to get purge count: %w", err)
	}

	return count, nil
}

// periodToModifier, period string'ini SQLite datetime modifier'a çevirir.
// Sadece bilinen değerler kabul edilir — SQL injection koruması.
func periodToModifier(period string) (string, error) {
	switch period {
	case "24h":
		return "-24 hours", nil
	case "7d":
		return "-7 days", nil
	case "30d":
		return "-30 days", nil
	default:
		return "", fmt.Errorf("invalid period: %s (expected 24h, 7d, or 30d)", period)
	}
}
