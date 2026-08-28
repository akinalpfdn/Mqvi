package georegion

import (
	"net/http"
	"testing"

	"github.com/akinalp/mqvi/models"
)

// The signal decides which SFU a whole channel lands on, so the failures that matter are silent
// ones: a country mapped to the wrong side of an ocean, or "unknown" treated as a real answer.

func TestFromCountry_SendsNorthAmericaWest(t *testing.T) {
	for _, c := range []string{"US", "CA", "MX", "BR"} {
		if got := FromCountry(c); got != models.RegionUSEast {
			t.Errorf("%s -> %q, want %q", c, got, models.RegionUSEast)
		}
	}
}

func TestFromCountry_SendsNordicsNorth(t *testing.T) {
	for _, c := range []string{"FI", "SE", "NO", "EE"} {
		if got := FromCountry(c); got != models.RegionEUNorth {
			t.Errorf("%s -> %q, want %q", c, got, models.RegionEUNorth)
		}
	}
}

func TestFromCountry_SendsAsiaPacific(t *testing.T) {
	for _, c := range []string{"SG", "JP", "AU", "IN"} {
		if got := FromCountry(c); got != models.RegionAPSoutheast {
			t.Errorf("%s -> %q, want %q", c, got, models.RegionAPSoutheast)
		}
	}
}

// An unlisted country is not an error — it lands on the default rather than becoming unknown,
// because a European default is a far better guess than no preference at all.
func TestFromCountry_UnlistedFallsToTheDefault(t *testing.T) {
	for _, c := range []string{"TR", "DE", "GB", "ZA", "PL"} {
		if got := FromCountry(c); got != models.RegionEUCentral {
			t.Errorf("%s -> %q, want the default %q", c, got, models.RegionEUCentral)
		}
	}
}

// These three must be unknown rather than defaulted: they mean "we do not know", and pretending
// otherwise sends someone across an ocean on no evidence.
func TestFromCountry_UnknownStaysUnknown(t *testing.T) {
	for _, c := range []string{"", "XX", "T1", "   "} {
		if got := FromCountry(c); got != models.RegionUnknown {
			t.Errorf("%q -> %q, want unknown", c, got)
		}
	}
}

func TestFromCountry_IsCaseAndSpaceInsensitive(t *testing.T) {
	for _, c := range []string{"ca", " CA ", "Ca"} {
		if got := FromCountry(c); got != models.RegionUSEast {
			t.Errorf("%q -> %q, want %q", c, got, models.RegionUSEast)
		}
	}
}

// Every region the mapping can produce must be one the server will accept, or selection quietly
// matches nothing.
func TestFromCountry_OnlyProducesValidRegions(t *testing.T) {
	seen := map[string]bool{}
	for c := range byCountry {
		seen[FromCountry(c)] = true
	}
	seen[defaultRegion] = true
	for region := range seen {
		if err := models.ValidateRegion(region); err != nil {
			t.Errorf("mapping produces %q which the server rejects: %v", region, err)
		}
	}
}

// The header missing is the case that will actually happen — local development, a hostname not
// proxied through Cloudflare, or IP Geolocation left switched off. All three must degrade to "no
// preference", never to a wrong one.
func TestFromRequest_MissingHeaderIsUnknown(t *testing.T) {
	r, _ := http.NewRequest(http.MethodPost, "/api/servers/s1/voice/token", nil)

	if got := FromRequest(r); got != models.RegionUnknown {
		t.Errorf("no header -> %q, want unknown", got)
	}
}

func TestFromRequest_ReadsTheCloudflareHeader(t *testing.T) {
	r, _ := http.NewRequest(http.MethodPost, "/api/servers/s1/voice/token", nil)
	r.Header.Set(CountryHeader, "CA")

	if got := FromRequest(r); got != models.RegionUSEast {
		t.Errorf("CA -> %q, want %q", got, models.RegionUSEast)
	}
}
