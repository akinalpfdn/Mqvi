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
	_ // 16 was the DM step, folded into friend; reserved so the bits after it keep their values
	guideProfile
	guideRoles
	guideApp
)

// GetState folds in every step the user's data shows now and returns what is stored: a step,
// once done, stays done (leaving every server or deleting the only message does not undo it).
// Steps come from existing rows, so a server joined through discovery, an invite or by creating
// it all count the same.
//
// Reading is the common case and costs no write: a step already done skips its subquery, and
// the row is only updated when a new step shows up. The update ORs in the row itself, so two
// concurrent calls cannot lose a bit.
func (r *sqliteGuideRepo) GetState(ctx context.Context, userID string) (*models.GuideState, error) {
	var done, found int
	var hidden bool
	err := r.db.QueryRowContext(ctx, `
		SELECT guide_done, guide_hidden,
			  (CASE WHEN guide_done & ? = 0 AND EXISTS(SELECT 1 FROM server_members WHERE user_id = u.id) THEN ? ELSE 0 END)
			| (CASE WHEN guide_done & ? = 0 AND EXISTS(SELECT 1 FROM messages WHERE user_id = u.id) THEN ? ELSE 0 END)
			| (CASE WHEN guide_done & ? = 0 AND u.last_voice_activity IS NOT NULL THEN ? ELSE 0 END)
			| (CASE WHEN guide_done & ? = 0 AND EXISTS(SELECT 1 FROM friendships
				WHERE (status = 'accepted' AND (user_id = u.id OR friend_id = u.id))
				   OR (status = 'pending' AND user_id = u.id)) THEN ? ELSE 0 END)
			| (CASE WHEN guide_done & ? = 0 AND COALESCE(u.avatar_url, '') != '' THEN ? ELSE 0 END)
			| (CASE WHEN guide_done & ? = 0 AND EXISTS(SELECT 1 FROM servers s JOIN roles r ON r.server_id = s.id
				WHERE s.owner_id = u.id AND r.is_default = 0 AND r.is_owner = 0) THEN ? ELSE 0 END)
			| (CASE WHEN guide_done & ? = 0 AND EXISTS(SELECT 1 FROM push_tokens
				WHERE user_id = u.id AND platform IN ('android', 'ios')) THEN ? ELSE 0 END)
		FROM users u
		WHERE u.id = ?`,
		guideCommunity, guideCommunity, guideMessage, guideMessage, guideVoice, guideVoice,
		guideFriend, guideFriend, guideProfile, guideProfile, guideRoles, guideRoles, guideApp, guideApp,
		userID,
	).Scan(&done, &hidden, &found)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("guide state for %s: %w", userID, pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("guide state for %s: %w", userID, err)
	}

	if found != 0 {
		err = r.db.QueryRowContext(ctx,
			`UPDATE users SET guide_done = guide_done | ? WHERE id = ? RETURNING guide_done, guide_hidden`,
			found, userID,
		).Scan(&done, &hidden)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("guide state for %s: %w", userID, pkg.ErrNotFound)
		}
		if err != nil {
			return nil, fmt.Errorf("record guide steps for %s: %w", userID, err)
		}
	}

	return &models.GuideState{Steps: stepsFrom(done), Hidden: hidden}, nil
}

func stepsFrom(done int) models.GuideSteps {
	return models.GuideSteps{
		Community: done&guideCommunity != 0,
		Message:   done&guideMessage != 0,
		Voice:     done&guideVoice != 0,
		Friend:    done&guideFriend != 0,
		Profile:   done&guideProfile != 0,
		Roles:     done&guideRoles != 0,
		App:       done&guideApp != 0,
	}
}

// MarkAppUsed records that the user ran the desktop app, which leaves no row of its own
// (the mobile app is seen through its push token).
func (r *sqliteGuideRepo) MarkAppUsed(ctx context.Context, userID string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE users SET guide_done = guide_done | ? WHERE id = ?`, guideApp, userID)
	if err != nil {
		return fmt.Errorf("mark app used for %s: %w", userID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("mark app used for %s: %w", userID, err)
	}
	if n == 0 {
		return fmt.Errorf("mark app used for %s: %w", userID, pkg.ErrNotFound)
	}
	return nil
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
