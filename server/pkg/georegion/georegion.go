// Package georegion turns "where did this request come from" into one of the regions a LiveKit
// instance can live in, so a call can be placed near the people in it.
//
// The signal is Cloudflare's CF-IPCountry header. It is set at the edge and overwrites anything a
// client sends, which is the property that matters here: with the first joiner claiming the
// instance for a whole channel, a signal the client could forge would let one person pin everyone
// else to a bad SFU. A client-side latency probe measures the truer thing — real RTT, peering and
// all — but it is exactly that forgeable, and it costs a round trip at the one moment users feel.
// Country granularity is enough when the regions are continents apart.
package georegion

import (
	"net/http"
	"strings"

	"github.com/akinalp/mqvi/models"
)

// CountryHeader is set by Cloudflare when IP Geolocation is enabled (Network settings, all plans
// including Free, off by default). Absent means we simply do not know — see FromRequest.
const CountryHeader = "CF-IPCountry"

// byCountry maps ISO 3166-1 alpha-2 to a region.
//
// Deliberately short. A full 250-entry table would be mostly guesswork about places with no
// instance anywhere near them, and every entry is a claim someone has to maintain. Only countries
// where the answer is both clear and different from the default are listed; everything else falls
// through to defaultRegion, which is where the instances actually are.
var byCountry = map[string]string{
	// North America — Ashburn beats Frankfurt by a wide margin for all of these.
	"US": models.RegionUSEast, "CA": models.RegionUSEast, "MX": models.RegionUSEast,
	"BR": models.RegionUSEast, "AR": models.RegionUSEast, "CL": models.RegionUSEast,
	"CO": models.RegionUSEast, "PE": models.RegionUSEast,

	// Nordics and the Baltics sit closer to Helsinki than to Nuremberg.
	"FI": models.RegionEUNorth, "SE": models.RegionEUNorth, "NO": models.RegionEUNorth,
	"DK": models.RegionEUNorth, "EE": models.RegionEUNorth, "LV": models.RegionEUNorth,
	"LT": models.RegionEUNorth, "IS": models.RegionEUNorth,

	// Asia-Pacific.
	"SG": models.RegionAPSoutheast, "MY": models.RegionAPSoutheast, "ID": models.RegionAPSoutheast,
	"TH": models.RegionAPSoutheast, "VN": models.RegionAPSoutheast, "PH": models.RegionAPSoutheast,
	"AU": models.RegionAPSoutheast, "NZ": models.RegionAPSoutheast, "JP": models.RegionAPSoutheast,
	"KR": models.RegionAPSoutheast, "IN": models.RegionAPSoutheast, "HK": models.RegionAPSoutheast,
	"TW": models.RegionAPSoutheast, "CN": models.RegionAPSoutheast,

	// US West is closer for the Pacific side of North America, but CF-IPCountry cannot tell
	// Vancouver from Toronto — country is the whole resolution we get. Left unmapped on purpose
	// rather than guessed at.
}

// defaultRegion is where an unlisted country goes. Europe, because that is where the instances are
// and where an unrecognised country is most likely to be closest to anyway.
const defaultRegion = models.RegionEUCentral

// FromCountry maps an ISO country code to a region. An empty or unknown code yields RegionUnknown
// rather than a guess: unknown falls through to load-based selection, which is exactly the old
// behaviour, whereas a wrong guess quietly sends someone across an ocean.
func FromCountry(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	// Cloudflare uses XX for unknown and T1 for Tor exit nodes. Neither says anything about where
	// the person is.
	if code == "" || code == "XX" || code == "T1" {
		return models.RegionUnknown
	}
	if region, ok := byCountry[code]; ok {
		return region
	}
	return defaultRegion
}

// FromRequest reads the region for an inbound request.
//
// Returns RegionUnknown when the header is missing, which happens in local development, when the
// hostname is not proxied through Cloudflare, and — the one worth noticing — when IP Geolocation
// has simply not been switched on. All three degrade to load-based selection rather than failing.
func FromRequest(r *http.Request) string {
	return FromCountry(r.Header.Get(CountryHeader))
}
