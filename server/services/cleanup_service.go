// Package services — CleanupService: embedded daily worker for soft-delete TTL,
// orphan file reconciliation, and disk-delete retry queue (Phase 16 P3).
//
// Runs in-process so self-host operators do not have to schedule a separate
// binary via cron. The scheduler ticks every 24 hours; on startup it consults
// cleanup_state.last_run_at to avoid double-runs after a restart.
//
// runOnce performs phases in order; a failure in one phase logs and
// continues to the next so a transient error never blocks the whole sweep:
//  1. Drain due retries (failed disk deletes from previous runs)
//  2. Tombstone soft-deleted users whose 30-day TTL has elapsed
//  3. Hard-delete soft-deleted servers whose 30-day TTL has elapsed
//  4. Clear stale quarantine and scan-cache rows
//  5. Walk the upload directory and reclaim orphan files (with 24h grace)
package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/repository"
)

// CleanupService is the public API for the embedded cleanup worker.
type CleanupService interface {
	// Start launches the daily scheduler goroutine. Idempotent.
	Start()
	// Stop signals the scheduler to exit and waits for an in-flight run to
	// finish. Safe to call before Start (no-op).
	Stop()
	// RunOnce executes a single sweep synchronously. Used by Start and exposed
	// for admin-triggered runs / tests.
	RunOnce(ctx context.Context) error
}

// SoftDeletedUserLister narrows UserRepository to the one method the worker
// needs. ISP — keeps the cleanup service decoupled from the full repo surface.
type SoftDeletedUserLister interface {
	ListSoftDeletedExpired(ctx context.Context, ttlDays int) ([]models.User, error)
}

// SoftDeletedServerLister narrows ServerRepository to the one method the worker needs.
type SoftDeletedServerLister interface {
	ListSoftDeletedExpired(ctx context.Context, ttlDays int) ([]models.Server, error)
}

// UserExpirer is the worker-driven half of AdminUserService.
type UserExpirer interface {
	ExpireSoftDeletedUser(ctx context.Context, targetUserID string) error
}

// ServerExpirer is the worker-driven half of AdminServerService.
type ServerExpirer interface {
	ExpireSoftDeletedServer(ctx context.Context, serverID string) error
}

type cleanupService struct {
	db            *sql.DB
	cleanupRepo   repository.CleanupRepository
	scanCache     repository.ScanHashCacheRepository
	userLister    SoftDeletedUserLister
	serverLister  SoftDeletedServerLister
	userExpirer   UserExpirer
	serverExpirer ServerExpirer
	fileDeleter   FileDeleter
	appLog        AppLogService
	uploadDir     string
	cleanScanTTL  time.Duration
	badScanTTL    time.Duration
	refSources    map[files.Kind][]string // nil = defaultReferenceSources; set by tests

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	started bool
}

// NewCleanupService wires the worker. uploadDir must match the configured
// files.Locator root so the orphan walk inspects the right tree.
func NewCleanupService(
	db *sql.DB,
	cleanupRepo repository.CleanupRepository,
	scanCache repository.ScanHashCacheRepository,
	userLister SoftDeletedUserLister,
	serverLister SoftDeletedServerLister,
	userExpirer UserExpirer,
	serverExpirer ServerExpirer,
	fileDeleter FileDeleter,
	appLog AppLogService,
	uploadDir string,
	cleanScanTTL time.Duration,
	badScanTTL time.Duration,
) CleanupService {
	return &cleanupService{
		db:            db,
		cleanupRepo:   cleanupRepo,
		scanCache:     scanCache,
		userLister:    userLister,
		serverLister:  serverLister,
		userExpirer:   userExpirer,
		serverExpirer: serverExpirer,
		fileDeleter:   fileDeleter,
		appLog:        appLog,
		uploadDir:     uploadDir,
		cleanScanTTL:  cleanScanTTL,
		badScanTTL:    badScanTTL,
	}
}

// Start launches the scheduler in a background goroutine.
func (s *cleanupService) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.done = make(chan struct{})
	s.started = true

	go s.scheduleLoop(ctx)
}

// Stop cancels the scheduler context and waits for the loop to exit. The
// last RunOnce call is allowed to finish — it does not respond to cancellation
// in the middle of a tombstone (interrupting a delete tx is worse than waiting).
func (s *cleanupService) Stop() {
	s.mu.Lock()
	if !s.started {
		s.mu.Unlock()
		return
	}
	cancel := s.cancel
	done := s.done
	s.started = false
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	log.Println("[cleanup] stopped")
}

func (s *cleanupService) scheduleLoop(ctx context.Context) {
	defer close(s.done)

	const interval = 24 * time.Hour

	// Decide initial wait: if the previous run is older than `interval` (or never
	// ran), fire ~30s after startup so the daemon has time to settle. Otherwise
	// schedule for the natural next tick. Prevents double-runs after a restart.
	last, err := s.cleanupRepo.GetLastRunAt(ctx)
	if err != nil {
		log.Printf("[cleanup] failed to read last_run_at: %v — defaulting to immediate run", err)
	}
	var firstWait time.Duration
	now := time.Now().UTC()
	switch {
	case last == nil || now.Sub(*last) >= interval:
		firstWait = 30 * time.Second
	default:
		firstWait = interval - now.Sub(*last)
	}

	timer := time.NewTimer(firstWait)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			runCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
			if runErr := s.RunOnce(runCtx); runErr != nil {
				log.Printf("[cleanup] run failed: %v", runErr)
			}
			cancel()
			timer.Reset(interval)
		}
	}
}

type runStats struct {
	retriesProcessed   int
	retriesSucceeded   int
	retriesGaveUp      int
	usersExpired       int
	usersFailed        int
	serversExpired     int
	serversFailed      int
	orphansDeleted     int
	orphansEnqueued    int
	quarantineDeleted  int
	scanCachePruned    int
	orphanScanDuration time.Duration
}

// RunOnce executes a full sweep. Errors are logged to AppLog (category=cleaner)
// rather than returned — the caller is the scheduler and there is nothing it
// can do with an error other than log it again.
func (s *cleanupService) RunOnce(ctx context.Context) error {
	start := time.Now().UTC()
	var st runStats

	s.processRetryQueue(ctx, &st)
	s.expireUsers(ctx, &st)
	s.expireServers(ctx, &st)
	s.cleanQuarantine(ctx, &st)
	s.pruneScanCache(ctx, &st)
	s.walkOrphans(ctx, &st)

	if err := s.cleanupRepo.SetLastRunAt(ctx, start); err != nil {
		log.Printf("[cleanup] failed to stamp last_run_at: %v", err)
	}

	level := models.LogLevelInfo
	if st.usersFailed > 0 || st.serversFailed > 0 || st.orphansEnqueued > 0 || st.retriesGaveUp > 0 {
		level = models.LogLevelWarn
	}
	msg := fmt.Sprintf(
		"cleanup sweep: users=%d/%d servers=%d/%d retries=%d/%d (gaveup=%d) quarantine=%d scan_cache=%d orphans=%d (queued=%d) duration=%s",
		st.usersExpired, st.usersExpired+st.usersFailed,
		st.serversExpired, st.serversExpired+st.serversFailed,
		st.retriesSucceeded, st.retriesProcessed, st.retriesGaveUp,
		st.quarantineDeleted, st.scanCachePruned,
		st.orphansDeleted, st.orphansEnqueued,
		time.Since(start).Round(time.Millisecond),
	)
	s.appLog.Log(level, models.LogCategoryCleaner, nil, nil, msg, map[string]string{
		"users_expired":      itoa(st.usersExpired),
		"users_failed":       itoa(st.usersFailed),
		"servers_expired":    itoa(st.serversExpired),
		"servers_failed":     itoa(st.serversFailed),
		"retries_processed":  itoa(st.retriesProcessed),
		"retries_succeeded":  itoa(st.retriesSucceeded),
		"retries_gaveup":     itoa(st.retriesGaveUp),
		"quarantine_deleted": itoa(st.quarantineDeleted),
		"scan_cache_pruned":  itoa(st.scanCachePruned),
		"orphans_deleted":    itoa(st.orphansDeleted),
		"orphans_enqueued":   itoa(st.orphansEnqueued),
		"orphan_scan_ms":     itoa(int(st.orphanScanDuration.Milliseconds())),
	})
	return nil
}

func (s *cleanupService) pruneScanCache(ctx context.Context, st *runStats) {
	if s.scanCache == nil {
		return
	}
	if s.cleanScanTTL > 0 {
		if s.deleteScanCacheBefore(ctx, st, "clean", time.Now().UTC().Add(-s.cleanScanTTL)) != nil {
			return
		}
	}
	if s.badScanTTL > 0 {
		_ = s.deleteScanCacheBefore(ctx, st, "infected", time.Now().UTC().Add(-s.badScanTTL))
	}
}

func (s *cleanupService) deleteScanCacheBefore(ctx context.Context, st *runStats, status string, cutoff time.Time) error {
	before := cutoff.Format("2006-01-02 15:04:05")
	n, err := s.scanCache.DeleteBefore(ctx, status, before)
	if err != nil {
		log.Printf("[cleanup] scan cache prune failed: %v", err)
		return err
	}
	st.scanCachePruned += n
	return nil
}

func (s *cleanupService) cleanQuarantine(ctx context.Context, st *runStats) {
	if s.uploadDir == "" {
		return
	}
	qdir := filepath.Join(s.uploadDir, ".quarantine")
	cutoff := time.Now().UTC().Add(-time.Hour)
	_ = filepath.WalkDir(qdir, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		info, err := d.Info()
		if err != nil || info.ModTime().UTC().After(cutoff) {
			return nil
		}
		if err := os.Remove(path); err == nil || os.IsNotExist(err) {
			st.quarantineDeleted++
		}
		return nil
	})
}

// processRetryQueue drains failed-file rows whose backoff has elapsed. Successes
// are deleted; failures bump retry_count and reschedule. Hitting MaxCleanupRetries
// is treated as permanent loss — logged at error level for operator follow-up.
func (s *cleanupService) processRetryQueue(ctx context.Context, st *runStats) {
	now := time.Now().UTC()
	due, err := s.cleanupRepo.ListDueRetries(ctx, now, models.MaxCleanupRetries)
	if err != nil {
		log.Printf("[cleanup] list due retries failed: %v", err)
		return
	}
	for _, item := range due {
		st.retriesProcessed++
		err := s.fileDeleter.DeleteFromURLChecked(item.FileURL)
		if err == nil {
			if delErr := s.cleanupRepo.DeleteFailedFile(ctx, item.ID); delErr != nil {
				log.Printf("[cleanup] failed to remove retry row %s: %v", item.ID, delErr)
			}
			st.retriesSucceeded++
			continue
		}
		nextCount := item.RetryCount + 1
		if nextCount >= models.MaxCleanupRetries {
			st.retriesGaveUp++
			s.appLog.Log(models.LogLevelError, models.LogCategoryCleaner, nil, nil,
				fmt.Sprintf("file delete permanently failed after %d retries: %s (%v)", nextCount, item.FileURL, err),
				map[string]string{"file_url": item.FileURL, "retry_count": itoa(nextCount), "reason": err.Error()},
			)
			// Bump the row anyway so ListDueRetries excludes it on subsequent runs.
			if bumpErr := s.cleanupRepo.BumpRetry(ctx, item.ID, now.Add(time.Hour), err.Error()); bumpErr != nil {
				log.Printf("[cleanup] failed to bump retry row %s: %v", item.ID, bumpErr)
			}
			continue
		}
		// Backoff: 2^nextCount minutes (1, 2, 4, 8, 16, 32, 64).
		backoff := time.Duration(1<<nextCount) * time.Minute
		if bumpErr := s.cleanupRepo.BumpRetry(ctx, item.ID, now.Add(backoff), err.Error()); bumpErr != nil {
			log.Printf("[cleanup] failed to bump retry row %s: %v", item.ID, bumpErr)
		}
	}
}

func (s *cleanupService) expireUsers(ctx context.Context, st *runStats) {
	users, err := s.userLister.ListSoftDeletedExpired(ctx, models.SoftDeleteTTLDays)
	if err != nil {
		log.Printf("[cleanup] list expired users failed: %v", err)
		s.appLog.Log(models.LogLevelError, models.LogCategoryCleaner, nil, nil,
			"failed to list expired users: "+err.Error(), nil)
		return
	}
	for _, u := range users {
		uid := u.ID
		if err := s.userExpirer.ExpireSoftDeletedUser(ctx, uid); err != nil {
			st.usersFailed++
			s.appLog.Log(models.LogLevelError, models.LogCategoryCleaner, &uid, nil,
				"failed to tombstone soft-deleted user: "+err.Error(),
				map[string]string{"user_id": uid},
			)
			continue
		}
		st.usersExpired++
	}
}

func (s *cleanupService) expireServers(ctx context.Context, st *runStats) {
	servers, err := s.serverLister.ListSoftDeletedExpired(ctx, models.SoftDeleteTTLDays)
	if err != nil {
		log.Printf("[cleanup] list expired servers failed: %v", err)
		s.appLog.Log(models.LogLevelError, models.LogCategoryCleaner, nil, nil,
			"failed to list expired servers: "+err.Error(), nil)
		return
	}
	for _, srv := range servers {
		sid := srv.ID
		if err := s.serverExpirer.ExpireSoftDeletedServer(ctx, sid); err != nil {
			st.serversFailed++
			s.appLog.Log(models.LogLevelError, models.LogCategoryCleaner, nil, &sid,
				"failed to hard-delete soft-deleted server: "+err.Error(),
				map[string]string{"server_id": sid},
			)
			continue
		}
		st.serversExpired++
	}
}

// walkOrphans builds a set of all URLs referenced by the DB and deletes any
// file under uploadDir that is not in the set AND whose mtime is older than
// 24h (grace period to avoid racing in-flight uploads).
func (s *cleanupService) walkOrphans(ctx context.Context, st *runStats) {
	if s.uploadDir == "" {
		return
	}
	walkStart := time.Now().UTC()
	defer func() { st.orphanScanDuration = time.Since(walkStart) }()

	referenced, err := s.collectReferencedURLs(ctx)
	if err != nil {
		log.Printf("[cleanup] collect referenced URLs failed: %v", err)
		s.appLog.Log(models.LogLevelError, models.LogCategoryCleaner, nil, nil,
			"orphan walk aborted: collect referenced URLs failed: "+err.Error(), nil)
		return
	}
	sources := s.sources()
	cutoff := time.Now().UTC().Add(-24 * time.Hour)

	walkErr := filepath.WalkDir(s.uploadDir, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == ".quarantine" {
				return filepath.SkipDir
			}
			return nil
		}
		// Build the URL representation: relative path under uploadDir, mapped to
		// /api/files/<kind>/<escape(scope)>/<escape(filename)>.
		rel, relErr := filepath.Rel(s.uploadDir, path)
		if relErr != nil {
			return nil
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) != 3 {
			// Skip anything outside the canonical kind/scope/filename layout
			// (legacy /api/uploads/* if any survived migration, partial uploads).
			return nil
		}
		// Only sweep a kind we know how to prove live. An unrecognised or unregistered kind
		// leaks disk; sweeping it would delete files nothing in the DB is watching over.
		if _, registered := sources[files.Kind(parts[0])]; !registered {
			return nil
		}
		fileURL := files.URLPathPrefix + "/" + parts[0] + "/" + url.PathEscape(parts[1]) + "/" + url.PathEscape(parts[2])
		if _, ok := referenced[fileURL]; ok {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		if info.ModTime().UTC().After(cutoff) {
			// Within 24h grace window — likely an in-flight upload.
			return nil
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			st.orphansEnqueued++
			nextRetry := time.Now().UTC().Add(time.Minute)
			if enqErr := s.cleanupRepo.EnqueueFailedFile(ctx, fileURL, err.Error(), nextRetry); enqErr != nil {
				log.Printf("[cleanup] enqueue orphan retry failed url=%s err=%v", fileURL, enqErr)
			}
			return nil
		}
		st.orphansDeleted++
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, os.ErrNotExist) {
		log.Printf("[cleanup] orphan walk error: %v", walkErr)
	}
}

// defaultReferenceSources maps every upload kind to the queries that prove its files are still
// live. A kind absent from this map is SKIPPED by the orphan walk, not swept: the cost of
// forgetting to register a new kind has to be leaked disk, never deleted user data. It was
// deleted user data — server banners (files.KindServerBanner, added with public-server
// discovery) had no entry here, so every banner was reclaimed by the first nightly sweep that
// ran more than 24h after it was uploaded, leaving servers.banner_url pointing at nothing.
//
// TestOrphanWalk_EveryUploadKindHasAReferenceSource fails until a new kind is registered.
var defaultReferenceSources = map[files.Kind][]string{
	files.KindMessage: {
		`SELECT file_url FROM attachments WHERE file_url IS NOT NULL AND file_url != ''`,
		`SELECT thumb_url FROM attachments WHERE thumb_url IS NOT NULL AND thumb_url != ''`,
	},
	files.KindDM: {
		`SELECT file_url FROM dm_attachments WHERE file_url IS NOT NULL AND file_url != ''`,
		`SELECT thumb_url FROM dm_attachments WHERE thumb_url IS NOT NULL AND thumb_url != ''`,
	},
	files.KindSoundboard:   {`SELECT file_url FROM soundboard_sounds WHERE file_url IS NOT NULL AND file_url != ''`},
	files.KindFeedback:     {`SELECT file_url FROM feedback_attachments WHERE file_url IS NOT NULL AND file_url != ''`},
	files.KindReport:       {`SELECT file_url FROM report_attachments WHERE file_url IS NOT NULL AND file_url != ''`},
	files.KindServerReport: {`SELECT file_url FROM server_report_attachments WHERE file_url IS NOT NULL AND file_url != ''`},
	files.KindVoiceMsg:     {`SELECT file_url FROM voice_message_attachments WHERE file_url IS NOT NULL AND file_url != ''`},
	files.KindAvatar:       {`SELECT avatar_url FROM users WHERE avatar_url IS NOT NULL AND avatar_url != ''`},
	files.KindWallpaper:    {`SELECT wallpaper_url FROM users WHERE wallpaper_url IS NOT NULL AND wallpaper_url != ''`},
	files.KindServerIcon:   {`SELECT icon_url FROM servers WHERE icon_url IS NOT NULL AND icon_url != ''`},
	files.KindServerBanner: {`SELECT banner_url FROM servers WHERE banner_url IS NOT NULL AND banner_url != ''`},
	files.KindBadge:        {`SELECT icon FROM badges WHERE icon_type = 'custom' AND icon IS NOT NULL AND icon != ''`},
}

// sources lets tests inject a partial map; nil means production.
func (s *cleanupService) sources() map[files.Kind][]string {
	if s.refSources != nil {
		return s.refSources
	}
	return defaultReferenceSources
}

// collectReferencedURLs aggregates every file URL the DB still considers live.
// Soft-deleted users/servers count as referenced — their files are reclaimed
// only when the tombstone runs (otherwise users could lose recoverable data).
//
// Any query that fails aborts the whole walk (see the caller): a schema change that broke one
// source would otherwise empty that kind's half of the set and sweep every live file in it.
func (s *cleanupService) collectReferencedURLs(ctx context.Context) (map[string]struct{}, error) {
	out := make(map[string]struct{}, 1024)
	// Iterate the source map itself, not files.AllKinds(). walkOrphans decides what is
	// sweepable from this same map, and the two must never disagree: a kind this loop skipped
	// but walkOrphans swept would have every one of its files deleted.
	for _, queries := range s.sources() {
		for _, q := range queries {
			rows, err := s.db.QueryContext(ctx, q)
			if err != nil {
				return nil, fmt.Errorf("query %q: %w", q, err)
			}
			for rows.Next() {
				var u string
				if err := rows.Scan(&u); err != nil {
					rows.Close()
					return nil, fmt.Errorf("scan %q: %w", q, err)
				}
				out[u] = struct{}{}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return nil, fmt.Errorf("iterate %q: %w", q, err)
			}
			rows.Close()
		}
	}
	return out, nil
}

// itoa is a tiny int→string helper that avoids pulling strconv into the metadata map.
func itoa(n int) string {
	return fmt.Sprintf("%d", n)
}
