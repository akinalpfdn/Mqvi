package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteGuideRepo struct {
	db database.TxQuerier
}

func NewSQLiteGuideRepo(db database.TxQuerier) GuideRepository {
	return &sqliteGuideRepo{db: db}
}

// Bits of users.guide_done.
const (
	guideCommunity = 1 << iota
	guideMessage
	guideVoice
	guideFriend
)

// GetState folds in every step the user's data shows now and returns what is stored, in one
// statement: a step, once done, stays done (leaving every server or deleting the only message
// does not undo it), and two concurrent calls cannot lose a bit — the OR happens in the row.
// Steps come from existing rows, so a server joined through discovery, an invite or by creating
// it all count the same.
func (r *sqliteGuideRepo) GetState(ctx context.Context, userID string) (*models.GuideState, error) {
	var done int
	var s models.GuideState
	err := r.db.QueryRowContext(ctx, `
		UPDATE users SET guide_done = guide_done
			| (CASE WHEN EXISTS(SELECT 1 FROM server_members WHERE user_id = users.id) THEN ? ELSE 0 END)
			| (CASE WHEN EXISTS(SELECT 1 FROM messages WHERE user_id = users.id) THEN ? ELSE 0 END)
			| (CASE WHEN users.last_voice_activity IS NOT NULL THEN ? ELSE 0 END)
			| (CASE WHEN EXISTS(SELECT 1 FROM friendships
				WHERE (status = 'accepted' AND (user_id = users.id OR friend_id = users.id))
				   OR (status = 'pending' AND user_id = users.id)) THEN ? ELSE 0 END)
		WHERE id = ?
		RETURNING guide_done, guide_hidden`,
		guideCommunity, guideMessage, guideVoice, guideFriend, userID,
	).Scan(&done, &s.Hidden)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("guide state for %s: %w", userID, pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("guide state for %s: %w", userID, err)
	}
	s.Steps = models.GuideSteps{
		Community: done&guideCommunity != 0,
		Message:   done&guideMessage != 0,
		Voice:     done&guideVoice != 0,
		Friend:    done&guideFriend != 0,
	}
	return &s, nil
}

func (r *sqliteGuideRepo) SetHidden(ctx context.Context, userID string, hidden bool) error {
	res, err := r.db.ExecContext(ctx, `UPDATE users SET guide_hidden = ? WHERE id = ?`, hidden, userID)
	if err != nil {
		return fmt.Errorf("set guide hidden for %s: %w", userID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("set guide hidden for %s: %w", userID, err)
	}
	if n == 0 {
		return fmt.Errorf("set guide hidden for %s: %w", userID, pkg.ErrNotFound)
	}
	return nil
}
