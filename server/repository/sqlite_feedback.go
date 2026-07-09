package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteFeedbackRepo struct {
	db database.TxQuerier
}

func NewSQLiteFeedbackRepo(db database.TxQuerier) FeedbackRepository {
	return &sqliteFeedbackRepo{db: db}
}

func (r *sqliteFeedbackRepo) CreateTicket(ctx context.Context, ticket *models.FeedbackTicket) error {
	query := `INSERT INTO feedback_tickets (id, user_id, type, subject, content, status)
		VALUES (?, ?, ?, ?, ?, ?)`
	_, err := r.db.ExecContext(ctx, query,
		ticket.ID, ticket.UserID, ticket.Type, ticket.Subject, ticket.Content, ticket.Status,
	)
	if err != nil {
		return fmt.Errorf("failed to create feedback ticket: %w", err)
	}
	return nil
}

func (r *sqliteFeedbackRepo) GetTicketByID(ctx context.Context, id string) (*models.FeedbackTicketWithUser, error) {
	query := `
		SELECT t.id, t.user_id, t.type, t.subject, t.content, t.status, t.created_at, t.updated_at,
			u.username, u.display_name,
			(SELECT COUNT(*) FROM feedback_replies WHERE ticket_id = t.id) AS reply_count
		FROM feedback_tickets t
		JOIN users u ON u.id = t.user_id
		WHERE t.id = ?`

	var ticket models.FeedbackTicketWithUser
	var displayName sql.NullString
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&ticket.ID, &ticket.UserID, &ticket.Type, &ticket.Subject, &ticket.Content,
		&ticket.Status, &ticket.CreatedAt, &ticket.UpdatedAt,
		&ticket.Username, &displayName, &ticket.ReplyCount,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get feedback ticket: %w", err)
	}
	if displayName.Valid {
		ticket.DisplayName = &displayName.String
	}
	return &ticket, nil
}

func (r *sqliteFeedbackRepo) ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error) {
	countQuery := `SELECT COUNT(*) FROM feedback_tickets WHERE user_id = ?`
	var total int
	if err := r.db.QueryRowContext(ctx, countQuery, userID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("failed to count user feedback: %w", err)
	}

	query := `
		SELECT t.id, t.user_id, t.type, t.subject, t.content, t.status, t.created_at, t.updated_at,
			u.username, u.display_name,
			(SELECT COUNT(*) FROM feedback_replies WHERE ticket_id = t.id) AS reply_count
		FROM feedback_tickets t
		JOIN users u ON u.id = t.user_id
		WHERE t.user_id = ?
		ORDER BY t.created_at DESC
		LIMIT ? OFFSET ?`

	return r.scanTickets(ctx, query, total, userID, limit, offset)
}

// feedbackSortColumns whitelists admin-list sort keys → SQL expressions. A key
// absent from this map falls back to created_at, so no caller string ever reaches
// ORDER BY directly.
var feedbackSortColumns = map[string]string{
	"created_at":  "t.created_at",
	"updated_at":  "t.updated_at",
	"status":      "t.status",
	"type":        "t.type",
	"subject":     "t.subject COLLATE NOCASE",
	"username":    "u.username COLLATE NOCASE",
	"reply_count": "reply_count",
	"is_unread":   "is_unread",
}

func (r *sqliteFeedbackRepo) ListAllForAdmin(ctx context.Context, p FeedbackListParams) ([]models.FeedbackTicketWithUser, int, error) {
	where := "WHERE 1=1"
	filterArgs := []any{}

	if len(p.Statuses) > 0 {
		where += " AND t.status IN (" + sqlPlaceholders(len(p.Statuses)) + ")"
		for _, s := range p.Statuses {
			filterArgs = append(filterArgs, s)
		}
	}
	if len(p.Types) > 0 {
		where += " AND t.type IN (" + sqlPlaceholders(len(p.Types)) + ")"
		for _, ty := range p.Types {
			filterArgs = append(filterArgs, ty)
		}
	}

	countQuery := fmt.Sprintf(`SELECT COUNT(*) FROM feedback_tickets t %s`, where)
	var total int
	if err := r.db.QueryRowContext(ctx, countQuery, filterArgs...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("failed to count feedback: %w", err)
	}

	sortCol, ok := feedbackSortColumns[p.SortKey]
	if !ok {
		sortCol = "t.created_at"
	}
	dir := "DESC"
	if p.SortDir == "asc" {
		dir = "ASC"
	}

	// is_unread: latest non-admin activity (ticket creation or a user reply) newer
	// than this admin's last_seen_at for the ticket. No read row => always unread.
	query := fmt.Sprintf(`
		SELECT t.id, t.user_id, t.type, t.subject, t.content, t.status, t.created_at, t.updated_at,
			u.username, u.display_name,
			(SELECT COUNT(*) FROM feedback_replies WHERE ticket_id = t.id) AS reply_count,
			CASE WHEN MAX(
				t.created_at,
				COALESCE((SELECT MAX(fr.created_at) FROM feedback_replies fr
					WHERE fr.ticket_id = t.id AND fr.is_admin = 0), '')
			) > COALESCE(ar.last_seen_at, '') THEN 1 ELSE 0 END AS is_unread
		FROM feedback_tickets t
		JOIN users u ON u.id = t.user_id
		LEFT JOIN feedback_ticket_admin_reads ar ON ar.ticket_id = t.id AND ar.admin_id = ?
		%s
		ORDER BY %s %s, t.created_at DESC
		LIMIT ? OFFSET ?`, where, sortCol, dir)

	args := make([]any, 0, len(filterArgs)+3)
	args = append(args, p.AdminID)
	args = append(args, filterArgs...)
	args = append(args, p.Limit, p.Offset)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list feedback: %w", err)
	}
	defer rows.Close()

	var tickets []models.FeedbackTicketWithUser
	for rows.Next() {
		var t models.FeedbackTicketWithUser
		var displayName sql.NullString
		if scanErr := rows.Scan(
			&t.ID, &t.UserID, &t.Type, &t.Subject, &t.Content,
			&t.Status, &t.CreatedAt, &t.UpdatedAt,
			&t.Username, &displayName, &t.ReplyCount, &t.IsUnread,
		); scanErr != nil {
			return nil, 0, fmt.Errorf("failed to scan feedback ticket: %w", scanErr)
		}
		if displayName.Valid {
			t.DisplayName = &displayName.String
		}
		tickets = append(tickets, t)
	}
	if rowErr := rows.Err(); rowErr != nil {
		return nil, 0, fmt.Errorf("error iterating feedback rows: %w", rowErr)
	}
	return tickets, total, nil
}

// sqlPlaceholders returns "?,?,...,?" with n placeholders.
func sqlPlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	s := strings.Repeat("?,", n)
	return s[:len(s)-1]
}

func (r *sqliteFeedbackRepo) scanTickets(ctx context.Context, query string, total int, args ...any) ([]models.FeedbackTicketWithUser, int, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list feedback: %w", err)
	}
	defer rows.Close()

	var tickets []models.FeedbackTicketWithUser
	for rows.Next() {
		var t models.FeedbackTicketWithUser
		var displayName sql.NullString
		if scanErr := rows.Scan(
			&t.ID, &t.UserID, &t.Type, &t.Subject, &t.Content,
			&t.Status, &t.CreatedAt, &t.UpdatedAt,
			&t.Username, &displayName, &t.ReplyCount,
		); scanErr != nil {
			return nil, 0, fmt.Errorf("failed to scan feedback ticket: %w", scanErr)
		}
		if displayName.Valid {
			t.DisplayName = &displayName.String
		}
		tickets = append(tickets, t)
	}
	if rowErr := rows.Err(); rowErr != nil {
		return nil, 0, fmt.Errorf("error iterating feedback rows: %w", rowErr)
	}

	return tickets, total, nil
}

func (r *sqliteFeedbackRepo) UpdateStatus(ctx context.Context, id string, status models.FeedbackStatus) error {
	query := `UPDATE feedback_tickets SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	result, err := r.db.ExecContext(ctx, query, status, id)
	if err != nil {
		return fmt.Errorf("failed to update feedback status: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("feedback ticket not found")
	}
	return nil
}

func (r *sqliteFeedbackRepo) MarkTicketSeen(ctx context.Context, adminID, ticketID string) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO feedback_ticket_admin_reads (admin_id, ticket_id, last_seen_at)
		VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		ON CONFLICT(admin_id, ticket_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
		adminID, ticketID,
	)
	if err != nil {
		return fmt.Errorf("failed to mark feedback ticket seen: %w", err)
	}
	return nil
}

func (r *sqliteFeedbackRepo) DeleteTicket(ctx context.Context, id string) error {
	// Replies are cascade-deleted by FK constraint
	result, err := r.db.ExecContext(ctx, `DELETE FROM feedback_tickets WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete feedback ticket: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("feedback ticket not found")
	}
	return nil
}

func (r *sqliteFeedbackRepo) CreateReply(ctx context.Context, reply *models.FeedbackReply) error {
	query := `INSERT INTO feedback_replies (id, ticket_id, user_id, is_admin, content) VALUES (?, ?, ?, ?, ?)
		RETURNING created_at`
	err := r.db.QueryRowContext(ctx, query,
		reply.ID, reply.TicketID, reply.UserID, reply.IsAdmin, reply.Content,
	).Scan(&reply.CreatedAt)
	if err != nil {
		return fmt.Errorf("failed to create feedback reply: %w", err)
	}

	// Update ticket's updated_at timestamp
	updateQuery := `UPDATE feedback_tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	_, _ = r.db.ExecContext(ctx, updateQuery, reply.TicketID)

	return nil
}

func (r *sqliteFeedbackRepo) GetRepliesByTicketID(ctx context.Context, ticketID string) ([]models.FeedbackReplyWithUser, error) {
	query := `
		SELECT r.id, r.ticket_id, r.user_id, r.is_admin, r.content, r.created_at,
			u.username, u.display_name
		FROM feedback_replies r
		JOIN users u ON u.id = r.user_id
		WHERE r.ticket_id = ?
		ORDER BY r.created_at ASC`

	rows, err := r.db.QueryContext(ctx, query, ticketID)
	if err != nil {
		return nil, fmt.Errorf("failed to get feedback replies: %w", err)
	}
	defer rows.Close()

	var replies []models.FeedbackReplyWithUser
	for rows.Next() {
		var reply models.FeedbackReplyWithUser
		var displayName sql.NullString
		if scanErr := rows.Scan(
			&reply.ID, &reply.TicketID, &reply.UserID, &reply.IsAdmin,
			&reply.Content, &reply.CreatedAt,
			&reply.Username, &displayName,
		); scanErr != nil {
			return nil, fmt.Errorf("failed to scan feedback reply: %w", scanErr)
		}
		if displayName.Valid {
			reply.DisplayName = &displayName.String
		}
		replies = append(replies, reply)
	}

	return replies, nil
}

func (r *sqliteFeedbackRepo) CreateAttachment(ctx context.Context, att *models.FeedbackAttachment) error {
	query := `INSERT INTO feedback_attachments (id, ticket_id, reply_id, filename, file_url, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?)`
	_, err := r.db.ExecContext(ctx, query, att.ID, att.TicketID, att.ReplyID, att.Filename, att.FileURL, att.FileSize, att.MimeType)
	if err != nil {
		return fmt.Errorf("failed to create feedback attachment: %w", err)
	}
	return nil
}

func (r *sqliteFeedbackRepo) GetAttachmentsByTicketID(ctx context.Context, ticketID string) ([]models.FeedbackAttachment, error) {
	query := `SELECT id, ticket_id, reply_id, filename, file_url, file_size, mime_type, created_at
		FROM feedback_attachments WHERE ticket_id = ? ORDER BY created_at ASC`
	rows, err := r.db.QueryContext(ctx, query, ticketID)
	if err != nil {
		return nil, fmt.Errorf("failed to get feedback attachments: %w", err)
	}
	defer rows.Close()

	var atts []models.FeedbackAttachment
	for rows.Next() {
		var a models.FeedbackAttachment
		if scanErr := rows.Scan(&a.ID, &a.TicketID, &a.ReplyID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt); scanErr != nil {
			return nil, fmt.Errorf("failed to scan feedback attachment: %w", scanErr)
		}
		atts = append(atts, a)
	}
	return atts, nil
}

func (r *sqliteFeedbackRepo) LatestCreatedAt(ctx context.Context) (*time.Time, error) {
	var s sql.NullString
	err := r.db.QueryRowContext(ctx, `SELECT MAX(created_at) FROM feedback_tickets`).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) || !s.Valid {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("feedback latest created_at: %w", err)
	}
	return parseSQLiteTimestamp(s.String)
}

func (r *sqliteFeedbackRepo) LatestAdminReplyForUser(ctx context.Context, userID string) (*time.Time, error) {
	var s sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT MAX(r.created_at) FROM feedback_replies r
		 JOIN feedback_tickets t ON t.id = r.ticket_id
		 WHERE t.user_id = ? AND r.is_admin = 1`,
		userID,
	).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) || !s.Valid {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("feedback latest admin reply: %w", err)
	}
	return parseSQLiteTimestamp(s.String)
}

// parseSQLiteTimestamp handles the formats modernc.org/sqlite returns for
// aggregate function results (MAX, MIN), which arrive as strings rather than
// time.Time. Tries RFC3339 first, then SQLite's default TEXT format.
func parseSQLiteTimestamp(value string) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05.999999999", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, value); err == nil {
			return &t, nil
		}
	}
	return nil, fmt.Errorf("unrecognized timestamp format: %q", value)
}
