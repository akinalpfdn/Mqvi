package repository

import (
	"context"
	"database/sql"
	"fmt"

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

func (r *sqliteFeedbackRepo) ListAll(ctx context.Context, status, ticketType string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error) {
	where := "WHERE 1=1"
	args := []any{}

	if status != "" {
		where += " AND t.status = ?"
		args = append(args, status)
	}
	if ticketType != "" {
		where += " AND t.type = ?"
		args = append(args, ticketType)
	}

	countQuery := fmt.Sprintf(`SELECT COUNT(*) FROM feedback_tickets t %s`, where)
	var total int
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("failed to count feedback: %w", err)
	}

	query := fmt.Sprintf(`
		SELECT t.id, t.user_id, t.type, t.subject, t.content, t.status, t.created_at, t.updated_at,
			u.username, u.display_name,
			(SELECT COUNT(*) FROM feedback_replies WHERE ticket_id = t.id) AS reply_count
		FROM feedback_tickets t
		JOIN users u ON u.id = t.user_id
		%s
		ORDER BY t.created_at DESC
		LIMIT ? OFFSET ?`, where)

	args = append(args, limit, offset)
	return r.scanTickets(ctx, query, total, args...)
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

func (r *sqliteFeedbackRepo) CreateReply(ctx context.Context, reply *models.FeedbackReply) error {
	query := `INSERT INTO feedback_replies (id, ticket_id, user_id, is_admin, content) VALUES (?, ?, ?, ?, ?)`
	_, err := r.db.ExecContext(ctx, query,
		reply.ID, reply.TicketID, reply.UserID, reply.IsAdmin, reply.Content,
	)
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
