package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteReadStateRepo struct {
	db database.TxQuerier
}

func NewSQLiteReadStateRepo(db database.TxQuerier) ReadStateRepository {
	return &sqliteReadStateRepo{db: db}
}

func (r *sqliteReadStateRepo) Upsert(ctx context.Context, userID, channelID, messageID string) error {
	// Mark-as-read path: reset unread_count to 0 alongside watermark update.
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at, unread_count)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0)
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
		              last_read_at = excluded.last_read_at,
		              unread_count = 0`

	_, err := r.db.ExecContext(ctx, query, userID, channelID, messageID)
	if err != nil {
		return fmt.Errorf("failed to upsert read state: %w", err)
	}
	return nil
}

// blockedAuthorFilter excludes readers who blocked the author: a blocked user's
// message is hidden client-side, so it must not count as unread either.
// Bind the author id once for the subquery. friendships: user_id = blocker.
const blockedAuthorFilter = `
		  AND user_id NOT IN (
		      SELECT user_id FROM friendships WHERE status = 'blocked' AND friend_id = ?
		  )`

// IncrementUnreadCounts bumps unread_count for every existing channel_reads
// row in this channel except the message author's and anyone who blocked them.
func (r *sqliteReadStateRepo) IncrementUnreadCounts(ctx context.Context, channelID, excludeUserID string) error {
	query := `
		UPDATE channel_reads
		SET unread_count = unread_count + 1
		WHERE channel_id = ? AND user_id != ?` + blockedAuthorFilter

	_, err := r.db.ExecContext(ctx, query, channelID, excludeUserID, excludeUserID)
	if err != nil {
		return fmt.Errorf("failed to increment unread counts: %w", err)
	}
	return nil
}

// DecrementUnreadForDeleted lowers unread_count by 1 on every channel_reads row
// whose owner had the deleted message counted as unread. CASE guard keeps the
// counter from going negative if state is ever out of sync.
//
// Readers who blocked the author before the message existed never had it counted
// (IncrementUnreadCounts skips them), so they are excluded; a block placed after
// the message still owes the decrement. Known drift, accepted: an unblock deletes
// the friendship row, so a later delete of a message that was never counted for
// that reader lowers their counter by one (and the reverse: a message hidden at
// arrival becomes visible but was never counted). Both self-heal on the next
// mark-as-read, which resets the counter to zero.
func (r *sqliteReadStateRepo) DecrementUnreadForDeleted(ctx context.Context, channelID, authorID string, deletedAt time.Time) error {
	query := `
		UPDATE channel_reads
		SET unread_count = CASE WHEN unread_count > 0 THEN unread_count - 1 ELSE 0 END
		WHERE channel_id = ?
		  AND user_id != ?
		  AND (
		      last_read_message_id IS NULL
		      OR ? > (SELECT created_at FROM messages WHERE id = last_read_message_id)
		  )
		  AND user_id NOT IN (
		      SELECT user_id FROM friendships
		      WHERE status = 'blocked' AND friend_id = ? AND created_at < ?
		  )`

	// friendships.created_at is always written from Go as a bound time.Time (never
	// CURRENT_TIMESTAMP), so binding the cut-off the same way — same driver, same layout,
	// both UTC — keeps the text comparison in chronological order without a Go-side round
	// trip per delete. messages.created_at is second-precision while blocks carry
	// nanoseconds, so the cut-off is the end of the message's second: a block inside that
	// second counts as "before" (conservative — a counter that may never have risen is not
	// lowered). TestDecrementUnreadForDeleted_BlockTiming pins this against the real driver.
	blockCutoff := deletedAt.UTC().Truncate(time.Second).Add(time.Second)
	_, err := r.db.ExecContext(ctx, query, channelID, authorID, deletedAt, authorID, blockCutoff)
	if err != nil {
		return fmt.Errorf("failed to decrement unread counts on delete: %w", err)
	}
	return nil
}

// GetUnreadCounts returns per-channel unread counts + mention watermarks.
// Returns rows when unread_count > 0 OR a mention watermark is set (so the watermark survives refresh).
func (r *sqliteReadStateRepo) GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error) {
	query := `
		SELECT id, unread_count, last_mention_seen_at, last_mention_seen_message_id FROM (
			SELECT c.id,
			       CASE WHEN cr.user_id IS NOT NULL
			            THEN cr.unread_count
			            ELSE (SELECT COUNT(*) FROM messages m
			                  WHERE m.channel_id = c.id
			                    AND m.user_id != ?
			                    AND m.user_id NOT IN (
			                        SELECT friend_id FROM friendships
			                        WHERE status = 'blocked' AND user_id = ?
			                    ))
			       END as unread_count,
			       cr.last_mention_seen_at as last_mention_seen_at,
			       cr.last_mention_seen_message_id as last_mention_seen_message_id
			FROM channels c
			LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ?
			WHERE c.type = 'text' AND c.server_id = ?
		) WHERE unread_count > 0 OR last_mention_seen_at IS NOT NULL`

	rows, err := r.db.QueryContext(ctx, query, userID, userID, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get unread counts: %w", err)
	}
	defer rows.Close()

	var unreads []models.UnreadInfo
	for rows.Next() {
		var info models.UnreadInfo
		if err := rows.Scan(
			&info.ChannelID,
			&info.UnreadCount,
			&info.LastMentionSeenAt,
			&info.LastMentionSeenMessageID,
		); err != nil {
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

// SetMentionSeen advances the (created_at, message_id) tuple watermark.
// Channel-guarded via id+channel_id match in the SELECT; monotonic via lex compare.
func (r *sqliteReadStateRepo) SetMentionSeen(ctx context.Context, userID, channelID, mentionMessageID string) error {
	query := `
		INSERT INTO channel_reads (
		    user_id, channel_id,
		    last_mention_seen_at, last_mention_seen_message_id,
		    unread_count
		)
		SELECT ?, ?, m.created_at, m.id,
		       (SELECT COUNT(*) FROM messages WHERE channel_id = ? AND user_id != ?)
		FROM messages m
		WHERE m.id = ? AND m.channel_id = ?
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_mention_seen_at = excluded.last_mention_seen_at,
		              last_mention_seen_message_id = excluded.last_mention_seen_message_id
		WHERE channel_reads.last_mention_seen_at IS NULL
		   OR excluded.last_mention_seen_at > channel_reads.last_mention_seen_at
		   OR (excluded.last_mention_seen_at = channel_reads.last_mention_seen_at
		       AND excluded.last_mention_seen_message_id > channel_reads.last_mention_seen_message_id)`

	_, err := r.db.ExecContext(ctx, query,
		userID, channelID,
		channelID, userID,
		mentionMessageID, channelID,
	)
	if err != nil {
		return fmt.Errorf("failed to set mention seen watermark: %w", err)
	}
	return nil
}

// MarkAllRead marks all text channels in a server as read for the user.
// Channels with no messages are skipped (INNER JOIN). Resets unread_count to 0.
func (r *sqliteReadStateRepo) MarkAllRead(ctx context.Context, userID, serverID string) error {
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at, unread_count)
		SELECT ?, c.id, latest.id, CURRENT_TIMESTAMP, 0
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
		              last_read_at = excluded.last_read_at,
		              unread_count = 0`

	_, err := r.db.ExecContext(ctx, query, userID, serverID)
	if err != nil {
		return fmt.Errorf("failed to mark all channels as read: %w", err)
	}
	return nil
}
