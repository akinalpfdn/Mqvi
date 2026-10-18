package geoip

import (
	"bytes"
	"compress/gzip"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
)

// A database shaped like DB-IP's city lite file, with one network in it.
func buildDatabase(t *testing.T, cidr, city, country string) []byte {
	t.Helper()
	tree, err := mmdbwriter.New(mmdbwriter.Options{DatabaseType: "DBIP-City-Lite", RecordSize: 24})
	if err != nil {
		t.Fatalf("new tree: %v", err)
	}
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatalf("parse cidr: %v", err)
	}
	record := mmdbtype.Map{
		"city":    mmdbtype.Map{"names": mmdbtype.Map{"en": mmdbtype.String(city)}},
		"country": mmdbtype.Map{"iso_code": mmdbtype.String(country)},
	}
	if err := tree.Insert(network, record); err != nil {
		t.Fatalf("insert: %v", err)
	}
	var buf bytes.Buffer
	if _, err := tree.WriteTo(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	return buf.Bytes()
}

func gzipped(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(data); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// Serves the given months; every other path is a 404, as DB-IP answers before publishing.
func dbipServer(t *testing.T, months map[string][]byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for month, body := range months {
			if r.URL.Path == "/"+filePrefix+month+fileSuffix+".gz" {
				_, _ = w.Write(body) // test server; a failed write fails the test's assertions
				return
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newTestUpdater(t *testing.T, baseURL string, now time.Time) (*Updater, *Reader, string) {
	t.Helper()
	dir := t.TempDir()
	reader := &Reader{}
	t.Cleanup(func() { _ = reader.Close() })
	u := NewUpdater(reader, dir, baseURL)
	u.now = func() time.Time { return now }
	return u, reader, dir
}

func TestReader_ShouldReturnCityAndCountryForAKnownAddress(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.mmdb")
	if err := os.WriteFile(path, buildDatabase(t, "81.214.0.0/16", "Istanbul", "TR"), 0o600); err != nil {
		t.Fatalf("write db: %v", err)
	}
	r := &Reader{}
	t.Cleanup(func() { _ = r.Close() })
	if err := r.Load(path); err != nil {
		t.Fatalf("load: %v", err)
	}

	city, country := r.Lookup("81.214.10.20")

	if city != "Istanbul" || country != "TR" {
		t.Fatalf("got %q %q", city, country)
	}
}

func TestReader_ShouldReturnNothingWhenNoDatabaseIsLoadedOrTheAddressIsBad(t *testing.T) {
	r := &Reader{}

	for _, ip := range []string{"81.214.10.20", "not-an-ip", ""} {
		if city, country := r.Lookup(ip); city != "" || country != "" {
			t.Fatalf("%q: got %q %q", ip, city, country)
		}
	}
}

func TestUpdater_ShouldDownloadAndLoadTheCurrentMonth(t *testing.T) {
	srv := dbipServer(t, map[string][]byte{
		"2026-10": gzipped(t, buildDatabase(t, "81.214.0.0/16", "Istanbul", "TR")),
	})
	u, reader, dir := newTestUpdater(t, srv.URL, time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC))

	if err := u.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	if city, _ := reader.Lookup("81.214.1.1"); city != "Istanbul" {
		t.Fatalf("city %q after refresh", city)
	}
	if _, err := os.Stat(filepath.Join(dir, "dbip-city-lite-2026-10.mmdb")); err != nil {
		t.Fatalf("database not kept on disk: %v", err)
	}
}

func TestUpdater_ShouldFallBackToLastMonthWhenThisMonthIsNotPublished(t *testing.T) {
	srv := dbipServer(t, map[string][]byte{
		"2026-09": gzipped(t, buildDatabase(t, "81.214.0.0/16", "Ankara", "TR")),
	})
	u, reader, _ := newTestUpdater(t, srv.URL, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))

	if err := u.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	if city, _ := reader.Lookup("81.214.1.1"); city != "Ankara" {
		t.Fatalf("city %q", city)
	}
}

func TestUpdater_ShouldReplaceAndRemoveTheOldMonthWhenANewOneArrives(t *testing.T) {
	srv := dbipServer(t, map[string][]byte{
		"2026-09": gzipped(t, buildDatabase(t, "81.214.0.0/16", "Ankara", "TR")),
		"2026-10": gzipped(t, buildDatabase(t, "81.214.0.0/16", "Istanbul", "TR")),
	})
	u, reader, dir := newTestUpdater(t, srv.URL, time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC))
	if err := u.Refresh(context.Background()); err != nil {
		t.Fatalf("first refresh: %v", err)
	}
	u.now = func() time.Time { return time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC) }

	if err := u.Refresh(context.Background()); err != nil {
		t.Fatalf("second refresh: %v", err)
	}

	if city, _ := reader.Lookup("81.214.1.1"); city != "Istanbul" {
		t.Fatalf("city %q after the new month", city)
	}
	if _, err := os.Stat(filepath.Join(dir, "dbip-city-lite-2026-09.mmdb")); !os.IsNotExist(err) {
		t.Fatalf("old month still on disk: %v", err)
	}
}

func TestUpdater_ShouldRejectAndDiscardACorruptDownload(t *testing.T) {
	srv := dbipServer(t, map[string][]byte{"2026-10": gzipped(t, []byte("not a database"))})
	u, reader, dir := newTestUpdater(t, srv.URL, time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC))

	if err := u.Refresh(context.Background()); err == nil {
		t.Fatal("corrupt database accepted")
	}

	if city, _ := reader.Lookup("81.214.1.1"); city != "" {
		t.Fatalf("lookup answered from a corrupt file: %q", city)
	}
	if files := u.localFiles(); len(files) != 0 {
		t.Fatalf("corrupt file left in %s: %v", dir, files)
	}
}
