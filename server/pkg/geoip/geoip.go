// Package geoip turns an IP address into a city and country for the active-devices screen.
//
// The data is DB-IP's free "IP to City Lite" database (CC BY 4.0 — the client shows the required
// "IP Geolocation by DB-IP" attribution next to the list). Unlike MaxMind's GeoLite2 it needs no
// account or key and may be redistributed, so a self-hosted server works without setup. It is
// downloaded on first start and refreshed monthly; until a copy exists, lookups return nothing.
package geoip

import (
	"fmt"
	"net/netip"
	"sync"

	"github.com/oschwald/maxminddb-golang/v2"
)

// Locator resolves an IP to a place. Empty strings mean unknown; it never fails a request.
type Locator interface {
	Lookup(ip string) (city, country string)
}

// Noop knows nothing. Used when the database is disabled.
type Noop struct{}

func (Noop) Lookup(string) (string, string) { return "", "" }

// Reader serves lookups from an mmdb file and can swap to a newer copy while in use.
type Reader struct {
	mu sync.RWMutex
	db *maxminddb.Reader // nil until a database has been loaded
}

type cityRecord struct {
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
}

func (r *Reader) Lookup(ip string) (string, string) {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return "", ""
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.db == nil {
		return "", ""
	}
	var rec cityRecord
	if err := r.db.Lookup(addr.Unmap()).Decode(&rec); err != nil {
		return "", ""
	}
	return rec.City.Names["en"], rec.Country.ISOCode
}

// Load opens path and, if it is a valid database, replaces the one in use.
func (r *Reader) Load(path string) error {
	db, err := maxminddb.Open(path)
	if err != nil {
		return fmt.Errorf("open geoip database %s: %w", path, err)
	}
	r.mu.Lock()
	old := r.db
	r.db = db
	r.mu.Unlock()
	if old != nil {
		if err := old.Close(); err != nil {
			return fmt.Errorf("close previous geoip database: %w", err)
		}
	}
	return nil
}

// Close releases the database.
func (r *Reader) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.db == nil {
		return nil
	}
	err := r.db.Close()
	r.db = nil
	return err
}
