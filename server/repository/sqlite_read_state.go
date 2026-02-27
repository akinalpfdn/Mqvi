package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akinalp/mqvi/models"
)

// sqliteReadStateRepo, ReadStateRepository interface'inin SQLite implementasyonu.
type sqliteReadStateRepo struct {
	db *sql.DB
}

// NewSQLiteReadStateRepo, constructor — interface döner.
func NewSQLiteReadStateRepo(db *sql.DB) ReadStateRepository {
	return &sqliteReadStateRepo{db: db}
}

// Upsert, bir kullanıcının belirli bir kanaldaki son okunan mesajını günceller.
//
// INSERT OR REPLACE kullanıyoruz (SQLite "upsert" pattern).
// PRIMARY KEY (user_id, channel_id) çakışırsa satır güncellenir.
//
// Neden UPSERT?
// Kullanıcı kanala ilk kez girdiğinde INSERT, sonraki seferlerde UPDATE olması gerekir.
// Tek sorgu ile her iki durumu da ele alıyoruz.
func (r *sqliteReadStateRepo) Upsert(ctx context.Context, userID, channelID, messageID string) error {
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
		              last_read_at = excluded.last_read_at`

	_, err := r.db.ExecContext(ctx, query, userID, channelID, messageID)
	if err != nil {
		return fmt.Errorf("failed to upsert read state: %w", err)
	}
	return nil
}

// GetUnreadCounts, bir kullanıcının tüm kanallarındaki okunmamış mesaj sayılarını döner.
//
// Sorgu mantığı:
// 1. channels tablosundan tüm text kanallarını al (voice kanalları hariç)
// 2. channel_reads ile LEFT JOIN — kullanıcının okuma durumunu bul
// 3. Okunmamış mesaj sayısı = last_read_message_id'den sonraki mesaj sayısı
// 4. Hiç okuma kaydı yoksa (yeni kanal) tüm mesajlar okunmamış sayılır
// 5. Sadece okunmamış > 0 olan kanalları döner (gereksiz veri gönderme)
//
// Performans notu:
// Her kanal için subquery yerine correlated subquery kullanıyoruz.
// Kanal sayısı genellikle düşük (10-50) olduğu için bu yeterince hızlı.
func (r *sqliteReadStateRepo) GetUnreadCounts(ctx context.Context, userID string) ([]models.UnreadInfo, error) {
	query := `
		SELECT id, unread_count FROM (
			SELECT c.id,
			       (SELECT COUNT(*) FROM messages m
			        WHERE m.channel_id = c.id
			          AND (cr.last_read_message_id IS NULL
			               OR m.created_at > (SELECT created_at FROM messages WHERE id = cr.last_read_message_id))
			       ) as unread_count
			FROM channels c
			LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ?
			WHERE c.type = 'text'
		) WHERE unread_count > 0`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get unread counts: %w", err)
	}
	defer rows.Close()

	var unreads []models.UnreadInfo
	for rows.Next() {
		var info models.UnreadInfo
		if err := rows.Scan(&info.ChannelID, &info.UnreadCount); err != nil {
			return nil, fmt.Errorf("failed to scan unread info: %w", err)
		}
		unreads = append(unreads, info)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating unread rows: %w", err)
	}

	if unreads == nil {
		unreads = []models.UnreadInfo{}
	}

	return unreads, nil
}
