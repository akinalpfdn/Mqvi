package repository

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

// sqliteReadStateRepo, ReadStateRepository interface'inin SQLite implementasyonu.
type sqliteReadStateRepo struct {
	db database.TxQuerier
}

// NewSQLiteReadStateRepo, constructor — interface döner.
func NewSQLiteReadStateRepo(db database.TxQuerier) ReadStateRepository {
	return &sqliteReadStateRepo{db: db}
}

// Upsert, bir kullanıcının belirli bir kanaldaki son okunan mesajını günceller.
//
// INSERT OR REPLACE kullanıyoruz (SQLite "upsert" pattern).
// PRIMARY KEY (user_id, channel_id) çakışırsa satır güncellenir.
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

// GetUnreadCounts, bir kullanıcının belirli bir sunucudaki okunmamış mesaj sayılarını döner.
//
// Sorgu mantığı:
// 1. channels tablosundan sunucuya ait text kanallarını al (voice kanalları hariç)
// 2. channel_reads ile LEFT JOIN — kullanıcının okuma durumunu bul
// 3. Okunmamış mesaj sayısı = last_read_message_id'den sonraki mesaj sayısı
// 4. Hiç okuma kaydı yoksa (yeni kanal) tüm mesajlar okunmamış sayılır
// 5. Sadece okunmamış > 0 olan kanalları döner
func (r *sqliteReadStateRepo) GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error) {
	// Okunmamış mesaj sayısını hesaplarken kullanıcının KENDİ mesajlarını hariç tut.
	// Kendi yazdığımız mesajlar "okunmamış" sayılmamalı — Discord da böyle çalışır.
	// m.user_id != ? filtresi olmazsa, fetchUnreadCounts kendi mesajlarımızı da sayar
	// ve server switch sonrası "tekrar unread" görünür.
	query := `
		SELECT id, unread_count FROM (
			SELECT c.id,
			       (SELECT COUNT(*) FROM messages m
			        WHERE m.channel_id = c.id
			          AND m.user_id != ?
			          AND (cr.last_read_message_id IS NULL
			               OR m.created_at > (SELECT created_at FROM messages WHERE id = cr.last_read_message_id))
			       ) as unread_count
			FROM channels c
			LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ?
			WHERE c.type = 'text' AND c.server_id = ?
		) WHERE unread_count > 0`

	rows, err := r.db.QueryContext(ctx, query, userID, userID, serverID)
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

// MarkAllRead, sunucudaki tüm text kanallarının son mesajını okunmuş olarak işaretler.
//
// Tek bir SQL ile tüm kanalları topluca upsert eder:
// 1. Sunucudaki her text kanalının en son mesajını bul (sub-query)
// 2. INSERT OR REPLACE ile read_states'e yaz
// Mesajı olmayan kanallar otomatik olarak hariç tutulur (INNER JOIN).
func (r *sqliteReadStateRepo) MarkAllRead(ctx context.Context, userID, serverID string) error {
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at)
		SELECT ?, c.id, latest.id, CURRENT_TIMESTAMP
		FROM channels c
		INNER JOIN (
			SELECT channel_id, id
			FROM messages m1
			WHERE m1.created_at = (
				SELECT MAX(m2.created_at) FROM messages m2 WHERE m2.channel_id = m1.channel_id
			)
		) latest ON latest.channel_id = c.id
		WHERE c.server_id = ? AND c.type = 'text'
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
		              last_read_at = excluded.last_read_at`

	_, err := r.db.ExecContext(ctx, query, userID, serverID)
	if err != nil {
		return fmt.Errorf("failed to mark all channels as read: %w", err)
	}
	return nil
}
