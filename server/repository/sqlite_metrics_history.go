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

func NewSQLiteMetricsHistoryRepo(db database.TxQuerier) MetricsHistoryRepository {
	return &sqliteMetricsHistoryRepo{db: db}
}

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

// GetSummary returns peak/average aggregates for a time period.
// Only available=1 records are included (unreachable snapshots excluded).
func (r *sqliteMetricsHistoryRepo) GetSummary(ctx context.Context, instanceID string, period string) (*models.MetricsHistorySummary, error) {
	cutoff := periodCutoff(period)

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
		  AND collected_at >= ?`

	summary := &models.MetricsHistorySummary{Period: period}

	var avgMemory float64
	err := r.db.QueryRowContext(ctx, query, instanceID, cutoff).Scan(
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

// GetTimeSeries returns time series data for charts.
// Aggregation depends on period: 24h = raw, 7d = hourly avg, 30d = 6-hour avg.
func (r *sqliteMetricsHistoryRepo) GetTimeSeries(ctx context.Context, instanceID string, period string) ([]models.MetricsTimeSeriesPoint, error) {
	cutoff := periodCutoff(period)

	var query string
	switch period {
	case "24h":
		query = `
			SELECT collected_at, cpu_pct, bandwidth_in_bps, bandwidth_out_bps, participant_count
			FROM livekit_metrics_history
			WHERE instance_id = ? AND available = 1 AND collected_at >= ?
			ORDER BY collected_at ASC`
	case "7d":
		query = `
			SELECT
				strftime('%Y-%m-%dT%H:00:00', collected_at) AS ts,
				AVG(cpu_pct), AVG(bandwidth_in_bps), AVG(bandwidth_out_bps),
				CAST(AVG(participant_count) AS INTEGER)
			FROM livekit_metrics_history
			WHERE instance_id = ? AND available = 1 AND collected_at >= ?
			GROUP BY strftime('%Y-%m-%dT%H:00:00', collected_at)
			ORDER BY ts ASC`
	case "30d":
		query = `
			SELECT
				strftime('%Y-%m-%dT', collected_at) ||
				printf('%02d', (CAST(strftime('%H', collected_at) AS INTEGER) / 6) * 6) ||
				':00:00' AS ts,
				AVG(cpu_pct), AVG(bandwidth_in_bps), AVG(bandwidth_out_bps),
				CAST(AVG(participant_count) AS INTEGER)
			FROM livekit_metrics_history
			WHERE instance_id = ? AND available = 1 AND collected_at >= ?
			GROUP BY ts
			ORDER BY ts ASC`
	}

	rows, qErr := r.db.QueryContext(ctx, query, instanceID, cutoff)
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
		parsed, parseErr := time.Parse(time.RFC3339, tsStr)
		if parseErr != nil {
			parsed, parseErr = time.Parse("2006-01-02T15:04:05", tsStr)
			if parseErr != nil {
				parsed, parseErr = time.Parse("2006-01-02 15:04:05", tsStr)
				if parseErr != nil {
					continue
				}
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

// periodCutoff computes cutoff timestamp string matching collected_at format.
// Uses time.Now() (not UTC) to match CURRENT_TIMESTAMP behavior in modernc.org/sqlite.
func periodCutoff(period string) string {
	now := time.Now()
	var d time.Duration
	switch period {
	case "7d":
		d = 7 * 24 * time.Hour
	case "30d":
		d = 30 * 24 * time.Hour
	default:
		d = 24 * time.Hour
	}
	return now.Add(-d).Format("2006-01-02 15:04:05")
}
