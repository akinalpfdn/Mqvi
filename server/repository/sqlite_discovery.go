package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteDiscoveryRepo struct {
	db database.TxQuerier
}

func NewSQLiteDiscoveryRepo(db database.TxQuerier) DiscoveryRepository {
	return &sqliteDiscoveryRepo{db: db}
}

// discoverySelectFields — card columns (excluding computed member_count/is_member which vary).
const discoverySelectFields = `s.id, s.name, s.icon_url, s.banner_url, s.description, s.category,
	s.verified, s.featured, s.approval_required,
	(SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id) AS member_count`

// buildDiscoveryFilter builds the WHERE for a public-server query. Trigram FTS needs >= 3 chars;
// shorter queries fall back to a name LIKE so search always returns something. The FTS match is a
// rowid subquery (the canonical FTS5 form) so the planner drives off the index cleanly.
func buildDiscoveryFilter(params models.PublicServerListParams) (whereSQL string, args []any) {
	clauses := []string{"s.is_public = 1", "s.deleted_at IS NULL"}

	if q := strings.TrimSpace(params.Search); q != "" {
		if utf8.RuneCountInString(q) >= 3 {
			clauses = append(clauses, "s.rowid IN (SELECT rowid FROM servers_fts WHERE servers_fts MATCH ?)")
			args = append(args, `"`+strings.ReplaceAll(q, `"`, `""`)+`"`)
		} else {
			clauses = append(clauses, "s.name LIKE ? COLLATE NOCASE")
			args = append(args, "%"+q+"%")
		}
	}
	if params.Category != "" {
		clauses = append(clauses, "s.category = ?")
		args = append(args, params.Category)
	}
	if params.FeaturedOnly {
		clauses = append(clauses, "s.featured = 1")
	}

	return "WHERE " + strings.Join(clauses, " AND "), args
}

func (r *sqliteDiscoveryRepo) ListPublicServers(ctx context.Context, params models.PublicServerListParams) (models.PublicServerListPage, error) {
	whereSQL, whereArgs := buildDiscoveryFilter(params)

	var total int
	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM servers s %s", whereSQL)
	if err := r.db.QueryRowContext(ctx, countQuery, whereArgs...).Scan(&total); err != nil {
		return models.PublicServerListPage{}, fmt.Errorf("count public servers: %w", err)
	}

	// Featured first, then busiest, then stable tiebreak. member_count is a correlated subquery,
	// so it is available to ORDER BY by alias.
	dataQuery := fmt.Sprintf(`
		SELECT %s,
			EXISTS(SELECT 1 FROM server_members sm2 WHERE sm2.server_id = s.id AND sm2.user_id = ?) AS is_member
		FROM servers s %s
		ORDER BY s.featured DESC, member_count DESC, s.id ASC
		LIMIT ? OFFSET ?`, discoverySelectFields, whereSQL)

	// Arg order matches the ?s in SQL text: is_member (SELECT) → where args → limit/offset.
	args := make([]any, 0, len(whereArgs)+3)
	args = append(args, params.RequestingUserID)
	args = append(args, whereArgs...)
	args = append(args, params.Limit, params.Offset)

	rows, err := r.db.QueryContext(ctx, dataQuery, args...)
	if err != nil {
		return models.PublicServerListPage{}, fmt.Errorf("list public servers: %w", err)
	}
	defer rows.Close()

	items := make([]models.PublicServerListItem, 0, params.Limit)
	for rows.Next() {
		item, err := scanDiscoveryItem(rows)
		if err != nil {
			return models.PublicServerListPage{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return models.PublicServerListPage{}, fmt.Errorf("iterate public servers: %w", err)
	}

	return models.PublicServerListPage{Items: items, Total: total}, nil
}

func (r *sqliteDiscoveryRepo) GetPublicServerItem(ctx context.Context, serverID, requestingUserID string) (*models.PublicServerListItem, error) {
	query := fmt.Sprintf(`
		SELECT %s,
			EXISTS(SELECT 1 FROM server_members sm2 WHERE sm2.server_id = s.id AND sm2.user_id = ?) AS is_member
		FROM servers s
		WHERE s.id = ? AND s.is_public = 1 AND s.deleted_at IS NULL`, discoverySelectFields)

	rows, err := r.db.QueryContext(ctx, query, requestingUserID, serverID)
	if err != nil {
		return nil, fmt.Errorf("get public server: %w", err)
	}
	defer rows.Close()

	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("get public server: %w", err)
		}
		return nil, pkg.ErrNotFound
	}
	item, err := scanDiscoveryItem(rows)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// scanDiscoveryItem scans one card row. is_member is a computed 0/1, scanned as int for driver safety.
func scanDiscoveryItem(rows *sql.Rows) (models.PublicServerListItem, error) {
	var item models.PublicServerListItem
	var isMember int
	if err := rows.Scan(
		&item.ID, &item.Name, &item.IconURL, &item.BannerURL, &item.Description, &item.Category,
		&item.Verified, &item.Featured, &item.ApprovalRequired,
		&item.MemberCount,
		&isMember,
	); err != nil {
		return item, fmt.Errorf("scan public server row: %w", err)
	}
	item.IsMember = isMember == 1
	return item, nil
}
