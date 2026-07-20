package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"os"
	"path/filepath"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/antivirus"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/repository"
)

const (
	antivirusPolicyAllowWithLog = "allow_with_log"
	antivirusPolicySkipWithLog  = "skip_with_log"
	antivirusPolicyReject       = "reject"
)

type StoredUpload struct {
	OriginalFilename string
	DiskFilename     string
	RelativeURL      string
	Size             int64
	SHA256           string
}

type UploadPipeline interface {
	Store(ctx context.Context, kind files.Kind, scopeID string, file multipart.File, header *multipart.FileHeader, maxSize int64) (*StoredUpload, error)
	DeleteFromURL(storedURL string)
}

type uploadPipeline struct {
	locator     *files.Locator
	scanner     antivirus.Scanner
	breaker     *antivirus.CircuitBreaker
	cache       repository.ScanHashCacheRepository
	appLog      AppLogService
	cfg         config.AntivirusConfig
	uploadDir   string
	cleanTTL    time.Duration
	infectedTTL time.Duration
}

func NewUploadPipeline(locator *files.Locator, scanner antivirus.Scanner, cache repository.ScanHashCacheRepository, appLog AppLogService, cfg config.AntivirusConfig) UploadPipeline {
	return &uploadPipeline{
		locator:     locator,
		scanner:     scanner,
		cache:       cache,
		appLog:      appLog,
		cfg:         cfg,
		uploadDir:   locator.UploadDir(),
		cleanTTL:    time.Duration(cfg.CleanCacheTTLHours) * time.Hour,
		infectedTTL: time.Duration(cfg.InfectedCacheTTLDays) * 24 * time.Hour,
		breaker: antivirus.NewCircuitBreaker(
			cfg.CircuitFailureThreshold,
			time.Duration(cfg.CircuitWindowSeconds)*time.Second,
			time.Duration(cfg.CircuitOpenSeconds)*time.Second,
		),
	}
}

func (p *uploadPipeline) Store(ctx context.Context, kind files.Kind, scopeID string, file multipart.File, header *multipart.FileHeader, maxSize int64) (*StoredUpload, error) {
	if header == nil {
		return nil, fmt.Errorf("%w: file header is required", pkg.ErrBadRequest)
	}

	diskFilename, err := files.GenerateDiskFilename(header.Filename)
	if err != nil {
		return nil, err
	}

	tmpPath, digest, realSize, err := p.writeQuarantine(file)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmpPath)

	if maxSize > 0 && realSize > maxSize {
		return nil, pkg.WithCode(fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, maxSize/(1024*1024)), pkg.CodeUploadTooLarge)
	}

	if err := p.authorizeScan(ctx, tmpPath, digest, realSize); err != nil {
		return nil, err
	}

	if err := p.locator.EnsureDir(kind, scopeID); err != nil {
		if errors.Is(err, files.ErrInvalidSegment) {
			return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
		}
		return nil, err
	}
	dest, err := p.locator.DiskPath(kind, scopeID, diskFilename)
	if err != nil {
		if errors.Is(err, files.ErrInvalidSegment) {
			return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
		}
		return nil, err
	}
	if err := os.Rename(tmpPath, dest); err != nil {
		return nil, fmt.Errorf("move upload into final storage: %w", err)
	}
	relURL, err := p.locator.RelativeURL(kind, scopeID, diskFilename)
	if err != nil {
		_ = os.Remove(dest)
		return nil, err
	}
	return &StoredUpload{
		OriginalFilename: header.Filename,
		DiskFilename:     diskFilename,
		RelativeURL:      relURL,
		Size:             realSize,
		SHA256:           digest,
	}, nil
}

func (p *uploadPipeline) DeleteFromURL(storedURL string) {
	p.locator.DeleteFromURL(storedURL)
}

func (p *uploadPipeline) writeQuarantine(src multipart.File) (string, string, int64, error) {
	qdir := filepath.Join(p.uploadDir, ".quarantine")
	if err := os.MkdirAll(qdir, 0o700); err != nil {
		return "", "", 0, fmt.Errorf("create quarantine dir: %w", err)
	}
	dst, err := os.CreateTemp(qdir, "upload-*")
	if err != nil {
		return "", "", 0, fmt.Errorf("create quarantine file: %w", err)
	}
	tmpPath := dst.Name()
	hasher := sha256.New()
	written, copyErr := io.Copy(dst, io.TeeReader(src, hasher))
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return "", "", 0, fmt.Errorf("write quarantine file: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return "", "", 0, fmt.Errorf("close quarantine file: %w", closeErr)
	}
	return tmpPath, hex.EncodeToString(hasher.Sum(nil)), written, nil
}

func (p *uploadPipeline) authorizeScan(ctx context.Context, path, digest string, size int64) error {
	if !p.cfg.Enabled {
		return nil
	}

	if ok, err := p.applyHashCache(ctx, digest); err != nil {
		return err
	} else if ok {
		return nil
	}

	if p.cfg.MaxScanSizeBytes > 0 && size > p.cfg.MaxScanSizeBytes {
		if p.cfg.TooLargePolicy == antivirusPolicyReject {
			p.logSecurity(models.LogLevelWarn, "upload rejected because file exceeds antivirus scan size", map[string]string{"sha256": digest})
			return pkg.WithCode(fmt.Errorf("%w: file is too large for security scan", pkg.ErrBadRequest), pkg.CodeUploadTooLargeScan)
		}
		p.logSecurity(models.LogLevelWarn, "upload skipped antivirus scan because file is too large", map[string]string{"sha256": digest})
		return nil
	}

	if p.scanner == nil {
		return p.handleUnavailable(digest, fmt.Errorf("scanner not configured"))
	}
	if p.breaker != nil && !p.breaker.Allow() {
		return p.handleUnavailable(digest, fmt.Errorf("scanner circuit open"))
	}

	res := p.scanner.Scan(ctx, path)
	if p.breaker != nil {
		p.breaker.Record(res.Status)
	}
	p.logScanResult(digest, res)

	switch res.Status {
	case antivirus.StatusClean:
		if p.cache != nil {
			if err := p.cache.Upsert(ctx, digest, string(antivirus.StatusClean), nil); err != nil {
				log.Printf("[antivirus] cache upsert failed: %v", err)
			}
		}
		return nil
	case antivirus.StatusInfected:
		if p.cache != nil {
			if err := p.cache.Upsert(ctx, digest, string(antivirus.StatusInfected), &res.Signature); err != nil {
				log.Printf("[antivirus] cache upsert failed: %v", err)
			}
		}
		p.logSecurity(models.LogLevelWarn, "infected upload rejected", map[string]string{"sha256": digest, "signature": res.Signature})
		return pkg.WithCode(fmt.Errorf("%w: file failed security scan", pkg.ErrBadRequest), pkg.CodeUploadInfected)
	case antivirus.StatusTooLarge:
		return p.handleTooLarge(digest)
	default:
		return p.handleUnavailable(digest, res.Err)
	}
}

func (p *uploadPipeline) applyHashCache(ctx context.Context, digest string) (bool, error) {
	if p.cache == nil {
		return false, nil
	}
	entry, err := p.cache.Get(ctx, digest)
	if err != nil || entry == nil {
		return false, err
	}
	scannedAt, err := parseScanTime(entry.ScannedAt)
	if err != nil {
		return false, nil
	}
	switch entry.Status {
	case string(antivirus.StatusClean):
		if time.Since(scannedAt) <= p.cleanTTL {
			return true, nil
		}
	case string(antivirus.StatusInfected):
		if time.Since(scannedAt) <= p.infectedTTL {
			sig := ""
			if entry.Signature != nil {
				sig = *entry.Signature
			}
			p.logSecurity(models.LogLevelWarn, "infected upload rejected from hash cache", map[string]string{"sha256": digest, "signature": sig})
			return false, pkg.WithCode(fmt.Errorf("%w: file failed security scan", pkg.ErrBadRequest), pkg.CodeUploadInfected)
		}
	}
	return false, nil
}

func (p *uploadPipeline) handleTooLarge(digest string) error {
	if p.cfg.TooLargePolicy == antivirusPolicyReject {
		p.logSecurity(models.LogLevelWarn, "upload rejected because antivirus scanner size limit was exceeded", map[string]string{"sha256": digest})
		return pkg.WithCode(fmt.Errorf("%w: file is too large for security scan", pkg.ErrBadRequest), pkg.CodeUploadTooLargeScan)
	}
	p.logSecurity(models.LogLevelWarn, "upload skipped antivirus scan because scanner size limit was exceeded", map[string]string{"sha256": digest})
	return nil
}

func (p *uploadPipeline) handleUnavailable(digest string, err error) error {
	meta := map[string]string{"sha256": digest}
	if err != nil {
		meta["error"] = err.Error()
	}
	if p.cfg.UnavailablePolicy == antivirusPolicyReject {
		p.logSecurity(models.LogLevelWarn, "upload rejected because antivirus scanner is unavailable", meta)
		return pkg.WithCode(fmt.Errorf("%w: file security scan is temporarily unavailable", pkg.ErrInternal), pkg.CodeUploadScanUnavailable)
	}
	p.logSecurity(models.LogLevelWarn, "upload allowed while antivirus scanner is unavailable", meta)
	return nil
}

func (p *uploadPipeline) logSecurity(level models.LogLevel, message string, meta map[string]string) {
	log.Printf("[antivirus] %s %v", message, meta)
	if p.appLog != nil {
		p.appLog.Log(level, models.LogCategoryGeneral, nil, nil, message, meta)
	}
}

func (p *uploadPipeline) logScanResult(digest string, res antivirus.Result) {
	meta := map[string]string{
		"sha256":      digest,
		"status":      string(res.Status),
		"duration_ms": fmt.Sprintf("%d", res.Duration.Milliseconds()),
	}
	if res.Signature != "" {
		meta["signature"] = res.Signature
	}
	if res.Err != nil {
		meta["error"] = res.Err.Error()
	}
	log.Printf("[antivirus] scan completed %v", meta)
}

func parseScanTime(value string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t, nil
	}
	return time.Parse("2006-01-02 15:04:05", value)
}

// ThumbnailUpload is the companion preview a client sends alongside an attachment.
//
// Always optional: old clients send none, non-image attachments have none, and client-side
// generation is allowed to fail without failing the send. Every consumer must treat nil as normal.
type ThumbnailUpload struct {
	File   multipart.File
	Header *multipart.FileHeader
	Width  int
	Height int
}

// storeThumbnail stores a companion preview beside its original.
//
// A thumbnail that fails to store must never fail the attachment: the preview is an optimisation,
// the file is the message. Callers get nils and carry on, and the client falls back to rendering
// the original as it did before thumbnails existed.
func storeThumbnail(
	ctx context.Context,
	pipeline UploadPipeline,
	kind files.Kind,
	scopeID string,
	thumb *ThumbnailUpload,
	maxSize int64,
) (url *string, width *int, height *int) {
	if thumb == nil || thumb.Header == nil {
		return nil, nil, nil
	}

	stored, err := pipeline.Store(ctx, kind, scopeID, thumb.File, thumb.Header, maxSize)
	if err != nil {
		log.Printf("[upload] thumbnail rejected for %s/%s: %v — attachment kept without one", kind, scopeID, err)
		return nil, nil, nil
	}

	// Dimensions are only useful together; a partial pair would make the client reserve wrong space.
	if thumb.Width > 0 && thumb.Height > 0 {
		width, height = &thumb.Width, &thumb.Height
	}
	return &stored.RelativeURL, width, height
}
