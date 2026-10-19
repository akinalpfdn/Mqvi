package geoip

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// DBIPBaseURL is where DB-IP publishes the monthly free databases.
const DBIPBaseURL = "https://download.db-ip.com/free"

const (
	filePrefix = "dbip-city-lite-"
	fileSuffix = ".mmdb"
	// The real file is ~130 MB; anything far past that is not the database.
	maxDatabaseBytes = 512 << 20
	checkInterval    = 24 * time.Hour
)

var errNotPublished = errors.New("database for this month is not published yet")

// Updater keeps the newest monthly database loaded in a Reader.
//
// Each month is its own file (dbip-city-lite-YYYY-MM.mmdb) rather than one file replaced in place:
// the reader memory-maps the file, and Windows will not rename over a mapped file.
type Updater struct {
	reader  *Reader
	dir     string
	baseURL string
	client  *http.Client
	now     func() time.Time

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	started bool
}

func NewUpdater(reader *Reader, dir, baseURL string) *Updater {
	return &Updater{
		reader:  reader,
		dir:     dir,
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: 10 * time.Minute},
		now:     time.Now,
	}
}

// LoadLocal loads the newest copy already on disk, if any. Start calls it; on its own it serves a
// server that must not reach out (auto-update off) from a file placed by hand.
func (u *Updater) LoadLocal() {
	if newest := u.newestLocal(); newest != "" {
		if err := u.reader.Load(newest); err != nil {
			log.Printf("[geoip] %v", err)
		}
	}
}

// Start loads the newest local copy at once, then downloads the current month in the background
// and re-checks daily. Idempotent.
func (u *Updater) Start() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.started {
		return
	}
	if err := os.MkdirAll(u.dir, 0o755); err != nil {
		log.Printf("[geoip] cannot create %s: %v — city lookups disabled", u.dir, err)
		return
	}
	u.LoadLocal()

	ctx, cancel := context.WithCancel(context.Background())
	u.cancel = cancel
	u.done = make(chan struct{})
	u.started = true
	go u.loop(ctx)
}

// Stop ends the background loop and waits for an in-flight download to finish or abort.
func (u *Updater) Stop() {
	u.mu.Lock()
	if !u.started {
		u.mu.Unlock()
		return
	}
	cancel, done := u.cancel, u.done
	u.started = false
	u.mu.Unlock()
	cancel()
	<-done
}

func (u *Updater) loop(ctx context.Context) {
	defer close(u.done)
	for {
		if err := u.Refresh(ctx); err != nil && ctx.Err() == nil {
			log.Printf("[geoip] refresh failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(checkInterval):
		}
	}
}

// Refresh makes sure this month's database (or last month's, early in a month before DB-IP has
// published) is on disk and loaded, and removes older copies.
func (u *Updater) Refresh(ctx context.Context) error {
	now := u.now().UTC()
	months := []string{now.Format("2006-01"), now.AddDate(0, -1, 0).Format("2006-01")}

	for _, month := range months {
		path := u.pathFor(month)
		if _, err := os.Stat(path); err == nil {
			return u.activate(path)
		}
		err := u.download(ctx, month, path)
		if errors.Is(err, errNotPublished) {
			continue
		}
		if err != nil {
			return err
		}
		return u.activate(path)
	}
	return fmt.Errorf("no database published for %s or %s", months[0], months[1])
}

func (u *Updater) activate(path string) error {
	if err := u.reader.Load(path); err != nil {
		// A corrupt copy would otherwise be found and failed on every check, never re-fetched.
		if rmErr := os.Remove(path); rmErr != nil {
			return fmt.Errorf("%w (and removing it failed: %v)", err, rmErr)
		}
		return err
	}
	for _, other := range u.localFiles() {
		if other != path {
			if err := os.Remove(other); err != nil {
				log.Printf("[geoip] could not remove old database %s: %v", other, err)
			}
		}
	}
	return nil
}

func (u *Updater) download(ctx context.Context, month, dest string) error {
	url := fmt.Sprintf("%s/%s%s%s.gz", u.baseURL, filePrefix, month, fileSuffix)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }() // read-only body; nothing to recover on close
	if resp.StatusCode == http.StatusNotFound {
		return errNotPublished
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}

	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return fmt.Errorf("gunzip %s: %w", url, err)
	}
	defer func() { _ = gz.Close() }() // decompressor holds no resource beyond the body

	tmp := dest + ".tmp"
	if err := writeLimited(tmp, gz); err != nil {
		_ = os.Remove(tmp) // best effort: a partial temp file is retried next check either way
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp) // as above
		return fmt.Errorf("move database into place: %w", err)
	}
	return nil
}

func writeLimited(path string, src io.Reader) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	n, copyErr := io.Copy(f, io.LimitReader(src, maxDatabaseBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		return fmt.Errorf("write %s: %w", path, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close %s: %w", path, closeErr)
	}
	if n > maxDatabaseBytes {
		return fmt.Errorf("database larger than %d bytes, refusing it", maxDatabaseBytes)
	}
	return nil
}

func (u *Updater) pathFor(month string) string {
	return filepath.Join(u.dir, filePrefix+month+fileSuffix)
}

func (u *Updater) localFiles() []string {
	matches, err := filepath.Glob(filepath.Join(u.dir, filePrefix+"*"+fileSuffix))
	if err != nil {
		return nil
	}
	sort.Strings(matches)
	return matches
}

func (u *Updater) newestLocal() string {
	files := u.localFiles()
	if len(files) == 0 {
		return ""
	}
	return files[len(files)-1]
}
