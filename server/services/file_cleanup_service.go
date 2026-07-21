package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// FileCleanupService handles bulk file deletion and quota release for cascading deletes.
// It runs cross-table SQL queries directly because it spans multiple domain boundaries.
//
// Two-phase design:
//  1. Collect* — gathers file references BEFORE the DB delete (read-only).
//  2. Execute — deletes files from disk and releases quota AFTER the DB delete succeeds.
//
// This ordering guarantees that a failed DB delete never leaves broken references
// (files deleted but DB rows still pointing to them).
//
// Execute uses context.Background() internally because it runs AFTER a successful
// DB delete — the request context may be cancelled but quota release must complete.
type FileCleanupService interface {
	CollectChannelFiles(ctx context.Context, channelID string) (*CleanupPlan, error)
	CollectServerFiles(ctx context.Context, serverID string) (*CleanupPlan, error)
	CollectUserFiles(ctx context.Context, userID string) (*CleanupPlan, error)
	CollectUserMessageFiles(ctx context.Context, userID string) (*CleanupPlan, error)
	// Execute deletes files from disk and releases quota. Safe to call with nil plan.
	// Uses context.Background() for quota release — must not depend on request lifecycle.
	Execute(plan *CleanupPlan)
}

// CleanupPlan holds file references collected before a DB delete.
type CleanupPlan struct {
	refs     []fileRef      // files with per-user quota tracking
	urls     []string       // standalone URLs without quota (avatars, wallpapers, icons)
	livekit  []livekitEntry // LiveKit instances to clean up (decrement or delete)
	skipUser string         // if set, skip quota release for this user (being deleted)
}

// livekitEntry describes a LiveKit instance that needs cleanup after server deletion.
type livekitEntry struct {
	InstanceID        string
	IsPlatformManaged bool
}

type fileRef struct {
	URL    string
	Size   int64
	UserID string
}

type fileCleanupService struct {
	db          *sql.DB
	fileDeleter FileDeleter
	storage     StorageService
	livekitRepo repository.LiveKitRepository
	cleanupRepo repository.CleanupRepository // optional: when set, failed deletes are enqueued for retry
}

func NewFileCleanupService(db *sql.DB, fileDeleter FileDeleter, storage StorageService, livekitRepo repository.LiveKitRepository, cleanupRepo repository.CleanupRepository) FileCleanupService {
	return &fileCleanupService{db: db, fileDeleter: fileDeleter, storage: storage, livekitRepo: livekitRepo, cleanupRepo: cleanupRepo}
}

func (s *fileCleanupService) CollectChannelFiles(ctx context.Context, channelID string) (*CleanupPlan, error) {
	refs, err := s.queryFileRefs(ctx, true, `
		SELECT a.file_url, COALESCE(a.file_size, 0), m.user_id, a.thumb_url, COALESCE(a.thumb_size, 0)
		FROM attachments a
		JOIN messages m ON a.message_id = m.id
		WHERE m.channel_id = ?`, channelID)
	if err != nil {
		return nil, fmt.Errorf("collect channel files: %w", err)
	}
	return &CleanupPlan{refs: refs}, nil
}

func (s *fileCleanupService) CollectServerFiles(ctx context.Context, serverID string) (*CleanupPlan, error) {
	plan := &CleanupPlan{}

	// Message attachments across all channels
	msgRefs, err := s.queryFileRefs(ctx, true, `
		SELECT a.file_url, COALESCE(a.file_size, 0), m.user_id, a.thumb_url, COALESCE(a.thumb_size, 0)
		FROM attachments a
		JOIN messages m ON a.message_id = m.id
		JOIN channels c ON m.channel_id = c.id
		WHERE c.server_id = ?`, serverID)
	if err != nil {
		return nil, fmt.Errorf("collect server message files: %w", err)
	}
	plan.refs = append(plan.refs, msgRefs...)

	// Soundboard files
	sbRefs, err := s.queryFileRefs(ctx, false, `
		SELECT file_url, COALESCE(file_size, 0), uploaded_by
		FROM soundboard_sounds
		WHERE server_id = ?`, serverID)
	if err != nil {
		return nil, fmt.Errorf("collect server soundboard files: %w", err)
	}
	plan.refs = append(plan.refs, sbRefs...)

	// Server icon + banner + LiveKit instance (single query to avoid extra round-trips)
	var iconURL, bannerURL, lkInstanceID *string
	if err := s.db.QueryRowContext(ctx,
		`SELECT icon_url, banner_url, livekit_instance_id FROM servers WHERE id = ?`, serverID,
	).Scan(&iconURL, &bannerURL, &lkInstanceID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("collect server icon/banner/livekit: %w", err)
	}
	if iconURL != nil && *iconURL != "" {
		plan.urls = append(plan.urls, *iconURL)
	}
	if bannerURL != nil && *bannerURL != "" {
		plan.urls = append(plan.urls, *bannerURL)
	}
	if lkInstanceID != nil {
		instance, lkErr := s.livekitRepo.GetByID(ctx, *lkInstanceID)
		if lkErr != nil && !errors.Is(lkErr, pkg.ErrNotFound) {
			return nil, fmt.Errorf("collect server livekit instance %s: %w", *lkInstanceID, lkErr)
		}
		if lkErr == nil {
			plan.livekit = append(plan.livekit, livekitEntry{
				InstanceID:        instance.ID,
				IsPlatformManaged: instance.IsPlatformManaged,
			})
		}
	}

	// Server-report evidence — uploader is the reporter (quota released back to them on delete).
	srRefs, err := s.queryFileRefs(ctx, false, `
		SELECT sra.file_url, COALESCE(sra.file_size, 0), sr.reporter_id
		FROM server_report_attachments sra
		JOIN server_reports sr ON sr.id = sra.server_report_id
		WHERE sr.server_id = ?`, serverID)
	if err != nil {
		return nil, fmt.Errorf("collect server report files: %w", err)
	}
	plan.refs = append(plan.refs, srRefs...)

	return plan, nil
}

func (s *fileCleanupService) CollectUserFiles(ctx context.Context, userID string) (*CleanupPlan, error) {
	plan := &CleanupPlan{skipUser: userID}

	// Avatar + wallpaper (no quota tracking — profile images)
	var avatarURL, wallpaperURL *string
	if err := s.db.QueryRowContext(ctx, `SELECT avatar_url, wallpaper_url FROM users WHERE id = ?`, userID).Scan(&avatarURL, &wallpaperURL); err != nil {
		return nil, fmt.Errorf("collect user avatar/wallpaper: %w", err)
	}
	if avatarURL != nil && *avatarURL != "" {
		plan.urls = append(plan.urls, *avatarURL)
	}
	if wallpaperURL != nil && *wallpaperURL != "" {
		plan.urls = append(plan.urls, *wallpaperURL)
	}

	// ─── Owned servers: collect ALL files (including other users' attachments) ───
	serverIDs, err := s.queryStrings(ctx, `SELECT id FROM servers WHERE owner_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("collect owned servers: %w", err)
	}
	for _, sid := range serverIDs {
		serverPlan, err := s.CollectServerFiles(ctx, sid)
		if err != nil {
			return nil, fmt.Errorf("collect owned server %s files: %w", sid, err)
		}
		plan.refs = append(plan.refs, serverPlan.refs...)
		plan.urls = append(plan.urls, serverPlan.urls...)
		plan.livekit = append(plan.livekit, serverPlan.livekit...)
	}

	// ─── User's own message attachments (in servers they don't own) ───
	msgRefs, err := s.queryFileRefs(ctx, true, `
		SELECT a.file_url, COALESCE(a.file_size, 0), m.user_id, a.thumb_url, COALESCE(a.thumb_size, 0)
		FROM attachments a
		JOIN messages m ON a.message_id = m.id
		WHERE m.user_id = ?
		  AND m.channel_id NOT IN (
		    SELECT c.id FROM channels c
		    JOIN servers s ON c.server_id = s.id
		    WHERE s.owner_id = ?
		  )`, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("collect user message files: %w", err)
	}
	plan.refs = append(plan.refs, msgRefs...)

	// ─── DM attachments ───
	dmRefs, err := s.queryOwnedRefs(ctx, userID, true, `
		SELECT da.file_url, COALESCE(da.file_size, 0), da.thumb_url, COALESCE(da.thumb_size, 0)
		FROM dm_attachments da
		JOIN dm_messages dm ON da.dm_message_id = dm.id
		WHERE dm.user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("collect user DM files: %w", err)
	}
	plan.refs = append(plan.refs, dmRefs...)

	// ─── Soundboard files in servers user doesn't own ───
	sbRefs, err := s.queryOwnedRefs(ctx, userID, false, `
		SELECT file_url, COALESCE(file_size, 0)
		FROM soundboard_sounds
		WHERE uploaded_by = ?
		  AND server_id NOT IN (SELECT id FROM servers WHERE owner_id = ?)`, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("collect user soundboard files: %w", err)
	}
	plan.refs = append(plan.refs, sbRefs...)

	// ─── Feedback attachments ───
	// 1) All attachments on user's own tickets (ticket-level + reply-level by anyone).
	//    Uploader is ticket creator for ticket attachments, reply creator for reply attachments.
	fbTicketRefs, err := s.queryFileRefs(ctx, false, `
		SELECT fa.file_url, COALESCE(fa.file_size, 0),
		       CASE WHEN fa.reply_id IS NOT NULL THEN fr.user_id ELSE ft.user_id END
		FROM feedback_attachments fa
		JOIN feedback_tickets ft ON fa.ticket_id = ft.id
		LEFT JOIN feedback_replies fr ON fa.reply_id = fr.id
		WHERE ft.user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("collect user feedback ticket files: %w", err)
	}
	plan.refs = append(plan.refs, fbTicketRefs...)

	// 2) Attachments on user's replies to OTHER users' tickets.
	//    These replies get deleted by HardDeleteUser's "DELETE FROM feedback_replies WHERE user_id = ?"
	//    which cascades to feedback_attachments via reply_id ON DELETE CASCADE.
	fbReplyRefs, err := s.queryOwnedRefs(ctx, userID, false, `
		SELECT fa.file_url, COALESCE(fa.file_size, 0)
		FROM feedback_attachments fa
		JOIN feedback_replies fr ON fa.reply_id = fr.id
		WHERE fr.user_id = ?
		  AND fa.ticket_id NOT IN (SELECT id FROM feedback_tickets WHERE user_id = ?)`, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("collect user feedback reply files: %w", err)
	}
	plan.refs = append(plan.refs, fbReplyRefs...)

	// ─── Report attachments ───
	// 1) Reports filed by user — uploader is the user.
	rpOwnRefs, err := s.queryOwnedRefs(ctx, userID, false, `
		SELECT ra.file_url, COALESCE(ra.file_size, 0)
		FROM report_attachments ra
		JOIN reports r ON ra.report_id = r.id
		WHERE r.reporter_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("collect user report files: %w", err)
	}
	plan.refs = append(plan.refs, rpOwnRefs...)

	// 2) Reports about user (filed by others) — uploader is the reporter.
	//    These get deleted by HardDeleteUser's "DELETE FROM reports WHERE ... OR reported_user_id = ?"
	//    which cascades to report_attachments.
	rpAboutRefs, err := s.queryFileRefs(ctx, false, `
		SELECT ra.file_url, COALESCE(ra.file_size, 0), r.reporter_id
		FROM report_attachments ra
		JOIN reports r ON ra.report_id = r.id
		WHERE r.reported_user_id = ? AND r.reporter_id != ?`, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("collect report-about-user files: %w", err)
	}
	plan.refs = append(plan.refs, rpAboutRefs...)

	return plan, nil
}

func (s *fileCleanupService) CollectUserMessageFiles(ctx context.Context, userID string) (*CleanupPlan, error) {
	plan := &CleanupPlan{}

	// Message attachments
	msgRefs, err := s.queryOwnedRefs(ctx, userID, true, `
		SELECT a.file_url, COALESCE(a.file_size, 0), a.thumb_url, COALESCE(a.thumb_size, 0)
		FROM attachments a
		JOIN messages m ON a.message_id = m.id
		WHERE m.user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("collect user message files: %w", err)
	}
	plan.refs = append(plan.refs, msgRefs...)

	// DM attachments
	dmRefs, err := s.queryOwnedRefs(ctx, userID, true, `
		SELECT da.file_url, COALESCE(da.file_size, 0), da.thumb_url, COALESCE(da.thumb_size, 0)
		FROM dm_attachments da
		JOIN dm_messages dm ON da.dm_message_id = dm.id
		WHERE dm.user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("collect user DM message files: %w", err)
	}
	plan.refs = append(plan.refs, dmRefs...)

	return plan, nil
}

// Execute deletes files from disk and releases per-user quota.
// Uses context.Background() for quota release — the DB delete already succeeded,
// so cleanup must complete regardless of the original request lifecycle.
//
// Failed disk deletes are enqueued to the cleanup retry queue (when wired) so
// the daily worker can drain transient IO/permissions errors with backoff.
// Quota is released regardless — quota tracks bytes the user owes, not disk
// reality, and orphan bytes will be reclaimed when the retry succeeds.
func (s *fileCleanupService) Execute(plan *CleanupPlan) {
	if plan == nil {
		return
	}

	ctx := context.Background()

	// Delete quota-tracked files and aggregate per-user bytes
	quotaByUser := make(map[string]int64)
	for _, ref := range plan.refs {
		s.deleteOrEnqueue(ctx, ref.URL)
		if ref.Size > 0 && ref.UserID != "" && ref.UserID != plan.skipUser {
			quotaByUser[ref.UserID] += ref.Size
		}
	}

	// Delete standalone URLs (no quota tracking)
	for _, u := range plan.urls {
		s.deleteOrEnqueue(ctx, u)
	}

	// Release quota per user
	for uid, bytes := range quotaByUser {
		if err := s.storage.Release(ctx, uid, bytes); err != nil {
			log.Printf("[cleanup] failed to release %d bytes for user %s: %v", bytes, uid, err)
		}
	}

	// LiveKit instance cleanup
	for _, lk := range plan.livekit {
		if lk.IsPlatformManaged {
			if err := s.livekitRepo.DecrementServerCount(ctx, lk.InstanceID); err != nil {
				log.Printf("[cleanup] failed to decrement livekit server count instance=%s: %v", lk.InstanceID, err)
			}
		} else {
			if err := s.livekitRepo.Delete(ctx, lk.InstanceID); err != nil {
				log.Printf("[cleanup] failed to delete self-hosted livekit instance=%s: %v", lk.InstanceID, err)
			}
		}
	}

	totalFiles := len(plan.refs) + len(plan.urls)
	if totalFiles > 0 || len(plan.livekit) > 0 {
		log.Printf("[cleanup] executed: %d files deleted, %d users' quota released, %d livekit instances cleaned", totalFiles, len(quotaByUser), len(plan.livekit))
	}
}

// deleteOrEnqueue tries the disk delete and enqueues the URL into the cleanup
// retry queue if it fails. Schedules first retry one minute from now (2^0 = 1).
// If no retry queue is wired, falls back to the swallow-errors variant.
func (s *fileCleanupService) deleteOrEnqueue(ctx context.Context, url string) {
	if s.cleanupRepo == nil {
		s.fileDeleter.DeleteFromURL(url)
		return
	}
	if err := s.fileDeleter.DeleteFromURLChecked(url); err != nil {
		log.Printf("[cleanup] disk delete failed url=%s err=%v — queued for retry", url, err)
		nextRetry := timeNow().Add(time.Minute)
		if enqErr := s.cleanupRepo.EnqueueFailedFile(ctx, url, err.Error(), nextRetry); enqErr != nil {
			log.Printf("[cleanup] enqueue retry failed url=%s err=%v", url, enqErr)
		}
	}
}

// timeNow is a function variable so tests can stub clock behavior.
var timeNow = func() time.Time { return time.Now().UTC() }

// ─── query helpers ───

// queryFileRefs runs a SELECT returning (file_url, file_size, user_id) rows, plus a trailing
// thumb_url column when withThumb is set. The caller states withThumb rather than the function
// guessing from the column count: a query that happened to return the trigger count, or a column
// added to an existing query, would otherwise silently mis-scan.
func (s *fileCleanupService) queryFileRefs(ctx context.Context, withThumb bool, query string, args ...any) ([]fileRef, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var refs []fileRef
	for rows.Next() {
		var r fileRef
		var thumb sql.NullString
		var thumbSize int64
		if withThumb {
			err = rows.Scan(&r.URL, &r.Size, &r.UserID, &thumb, &thumbSize)
		} else {
			err = rows.Scan(&r.URL, &r.Size, &r.UserID)
		}
		if err != nil {
			return nil, fmt.Errorf("scan file ref: %w", err)
		}
		refs = append(refs, r)
		refs = appendThumbRef(refs, thumb, thumbSize, r.UserID)
	}
	return refs, rows.Err()
}

// A withThumb query returns thumb_url and thumb_size as trailing columns. A non-null URL becomes a
// second ref so a companion thumbnail is deleted along with its original instead of being orphaned
// on disk, and carries its size so the quota it was charged at upload is given back.
func appendThumbRef(refs []fileRef, thumb sql.NullString, size int64, userID string) []fileRef {
	if !thumb.Valid || thumb.String == "" {
		return refs
	}
	return append(refs, fileRef{URL: thumb.String, Size: size, UserID: userID})
}

// queryOwnedRefs runs a SELECT returning (file_url, file_size) rows tagged with ownerID, plus a
// trailing thumb_url column when withThumb is set. withThumb is explicit for the same reason as
// queryFileRefs — no guessing from column count.
func (s *fileCleanupService) queryOwnedRefs(ctx context.Context, ownerID string, withThumb bool, query string, args ...any) ([]fileRef, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var refs []fileRef
	for rows.Next() {
		var r fileRef
		var thumb sql.NullString
		var thumbSize int64
		if withThumb {
			err = rows.Scan(&r.URL, &r.Size, &thumb, &thumbSize)
		} else {
			err = rows.Scan(&r.URL, &r.Size)
		}
		if err != nil {
			return nil, fmt.Errorf("scan owned ref: %w", err)
		}
		r.UserID = ownerID
		refs = append(refs, r)
		refs = appendThumbRef(refs, thumb, thumbSize, ownerID)
	}
	return refs, rows.Err()
}

// queryStrings runs a SELECT that returns single-column string rows.
func (s *fileCleanupService) queryStrings(ctx context.Context, query string, args ...any) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var val string
		if err := rows.Scan(&val); err != nil {
			return nil, fmt.Errorf("scan string: %w", err)
		}
		result = append(result, val)
	}
	return result, rows.Err()
}
