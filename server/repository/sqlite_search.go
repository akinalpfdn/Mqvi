package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/models"
)

// sqliteSearchRepo, SearchRepository interface'inin SQLite FTS5 implementasyonu.
type sqliteSearchRepo struct {
	db *sql.DB
}

// NewSQLiteSearchRepo, constructor — interface döner.
func NewSQLiteSearchRepo(db *sql.DB) SearchRepository {
	return &sqliteSearchRepo{db: db}
}

// Search, FTS5 ile tam metin araması yapar.
//
// FTS5 sorgu mantığı:
// 1. messages_fts tablosunda MATCH ile arama yap
// 2. Bulunan rowid'ler ile messages tablosunu JOIN et
// 3. Opsiyonel kanal filtresi uygula
// 4. Yazar bilgisini JOIN ile çek
// 5. BM25 ranking ile sırala (en alakalı üstte)
//
// BM25 nedir?
// "Best Matching 25" — bilgi erişiminde yaygın kullanılan bir ranking algoritması.
// Arama teriminin dokümandaki frekansına ve doküman uzunluğuna göre skor hesaplar.
// FTS5'in `rank` sütunu otomatik olarak BM25 skoru döner.
func (r *sqliteSearchRepo) Search(ctx context.Context, query string, channelID *string, limit, offset int) (*SearchResult, error) {
	// Limit koruma
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	// FTS5 query sanitize — kullanıcı girdisini güvenli hale getir.
	// FTS5'in özel operatörlerini (AND, OR, NOT, NEAR) kötüye kullanılmaktan korumak için
	// her kelimeyi tırnak içine alıyoruz.
	safeQuery := sanitizeFTSQuery(query)
	if safeQuery == "" {
		return &SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
	}

	// Sonuçları ve toplam sayıyı çekmek için 2 sorgu kullanıyoruz.
	// Alternatif: CTE ile tek sorguda yapılabilir ama okunabilirlik için ayrı tuttuk.

	// 1. Toplam sonuç sayısı
	var countQuery string
	var countArgs []any

	if channelID != nil {
		countQuery = `
			SELECT COUNT(*)
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			WHERE messages_fts MATCH ? AND m.channel_id = ?`
		countArgs = []any{safeQuery, *channelID}
	} else {
		countQuery = `
			SELECT COUNT(*)
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			WHERE messages_fts MATCH ?`
		countArgs = []any{safeQuery}
	}

	var totalCount int
	if err := r.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&totalCount); err != nil {
		return nil, fmt.Errorf("failed to count search results: %w", err)
	}

	if totalCount == 0 {
		return &SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
	}

	// 2. Sayfalanmış sonuçlar
	var dataQuery string
	var dataArgs []any

	if channelID != nil {
		dataQuery = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       u.id, u.username, u.display_name, u.avatar_url, u.status
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			LEFT JOIN users u ON m.user_id = u.id
			WHERE messages_fts MATCH ? AND m.channel_id = ?
			ORDER BY fts.rank
			LIMIT ? OFFSET ?`
		dataArgs = []any{safeQuery, *channelID, limit, offset}
	} else {
		dataQuery = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       u.id, u.username, u.display_name, u.avatar_url, u.status
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			LEFT JOIN users u ON m.user_id = u.id
			WHERE messages_fts MATCH ?
			ORDER BY fts.rank
			LIMIT ? OFFSET ?`
		dataArgs = []any{safeQuery, limit, offset}
	}

	rows, err := r.db.QueryContext(ctx, dataQuery, dataArgs...)
	if err != nil {
		return nil, fmt.Errorf("failed to search messages: %w", err)
	}
	defer rows.Close()

	var messages []models.Message
	for rows.Next() {
		var msg models.Message
		var author models.User
		var authorID sql.NullString

		if err := rows.Scan(
			&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
			&authorID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.Status,
		); err != nil {
			return nil, fmt.Errorf("failed to scan search result row: %w", err)
		}

		if authorID.Valid {
			author.ID = authorID.String
			author.PasswordHash = ""
			msg.Author = &author
		}
		msg.Attachments = []models.Attachment{}

		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating search result rows: %w", err)
	}

	if messages == nil {
		messages = []models.Message{}
	}

	return &SearchResult{
		Messages:   messages,
		TotalCount: totalCount,
	}, nil
}

// sanitizeFTSQuery, kullanıcı girdisini FTS5-safe formata dönüştürür.
//
// FTS5 özel operatörleri (AND, OR, NOT, NEAR, *, ^) kötüye kullanılabilir.
// Bu fonksiyon her kelimeyi çift tırnak içine alarak literal arama yapar.
// Boş kelimeler ve 1 karakterden kısa kelimeler filtrelenir.
func sanitizeFTSQuery(query string) string {
	words := strings.Fields(query)
	if len(words) == 0 {
		return ""
	}

	var safe []string
	for _, w := range words {
		// Çift tırnak içindeki tırnakları kaldır (injection önleme)
		cleaned := strings.ReplaceAll(w, "\"", "")
		if len(cleaned) < 1 {
			continue
		}
		safe = append(safe, "\""+cleaned+"\"")
	}

	if len(safe) == 0 {
		return ""
	}

	// Kelimeler arasında implicit AND (FTS5 varsayılanı)
	return strings.Join(safe, " ")
}
