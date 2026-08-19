package models

import (
	"fmt"
	"strings"
	"time"
)

// LiveKitInstance — credentials are stored AES-256-GCM encrypted in DB.
// Values here are decrypted; json:"-" prevents them from ever reaching the client.
type LiveKitInstance struct {
	ID                string    `json:"id"`
	URL               string    `json:"url"`
	APIKey            string    `json:"-"`
	APISecret         string    `json:"-"`
	IsPlatformManaged bool      `json:"is_platform_managed"`
	ServerCount       int       `json:"server_count"`
	MaxServers        int       `json:"max_servers"` // 0 = unlimited
	HetznerServerID   string    `json:"hetzner_server_id"`
	// Region is operator-facing only. Which SFU a member is on is not theirs to see, and telling
	// them where it sits adds nothing they can act on.
	Region    string    `json:"-"`
	CreatedAt time.Time `json:"created_at"`
}

// LiveKitInstanceAdminView — credentials are NEVER exposed, even to admins.
type LiveKitInstanceAdminView struct {
	ID                string    `json:"id"`
	URL               string    `json:"url"`
	IsPlatformManaged bool      `json:"is_platform_managed"`
	ServerCount       int       `json:"server_count"`
	MaxServers        int       `json:"max_servers"`
	HetznerServerID   string    `json:"hetzner_server_id"`
	Region            string    `json:"region"`
	CreatedAt         time.Time `json:"created_at"`
}

type CreateLiveKitInstanceRequest struct {
	URL             string `json:"url"`
	APIKey          string `json:"api_key"`
	APISecret       string `json:"api_secret"`
	MaxServers      int    `json:"max_servers"`
	HetznerServerID string `json:"hetzner_server_id"`
	Region          string `json:"region"`
}

func (r *CreateLiveKitInstanceRequest) Validate() error {
	r.URL = strings.TrimSpace(r.URL)
	if r.URL == "" {
		return fmt.Errorf("url is required")
	}
	r.APIKey = strings.TrimSpace(r.APIKey)
	if r.APIKey == "" {
		return fmt.Errorf("api_key is required")
	}
	r.APISecret = strings.TrimSpace(r.APISecret)
	if r.APISecret == "" {
		return fmt.Errorf("api_secret is required")
	}
	if r.MaxServers < 0 {
		return fmt.Errorf("max_servers must be >= 0")
	}
	r.Region = strings.TrimSpace(r.Region)
	if err := ValidateRegion(r.Region); err != nil {
		return err
	}
	return nil
}

// UpdateLiveKitInstanceRequest — nil fields are not updated.
// Empty credentials keep existing values.
type UpdateLiveKitInstanceRequest struct {
	URL             *string `json:"url"`
	APIKey          *string `json:"api_key"`
	APISecret       *string `json:"api_secret"`
	MaxServers      *int    `json:"max_servers"`
	HetznerServerID *string `json:"hetzner_server_id"`
	Region          *string `json:"region"`
}

func (r *UpdateLiveKitInstanceRequest) Validate() error {
	if r.URL != nil {
		trimmed := strings.TrimSpace(*r.URL)
		r.URL = &trimmed
		if trimmed == "" {
			return fmt.Errorf("url cannot be empty")
		}
	}
	if r.APIKey != nil {
		trimmed := strings.TrimSpace(*r.APIKey)
		r.APIKey = &trimmed
		if trimmed == "" {
			return fmt.Errorf("api_key cannot be empty")
		}
	}
	if r.APISecret != nil {
		trimmed := strings.TrimSpace(*r.APISecret)
		r.APISecret = &trimmed
		if trimmed == "" {
			return fmt.Errorf("api_secret cannot be empty")
		}
	}
	if r.MaxServers != nil && *r.MaxServers < 0 {
		return fmt.Errorf("max_servers must be >= 0")
	}
	if r.Region != nil {
		trimmed := strings.TrimSpace(*r.Region)
		r.Region = &trimmed
		if err := ValidateRegion(trimmed); err != nil {
			return err
		}
	}
	return nil
}

// Regions a LiveKit instance may be placed in.
//
// A closed set rather than free text: the value drives which SFU a call is sent to, and an operator
// typo would silently create a region nobody is ever matched to — an instance that quietly serves
// no one. Broad areas, not datacenter names, because the question being answered is "roughly where
// are you" and instances move between facilities within an area.
//
// Empty is valid and means unknown. Every instance that predates the column is unknown until an
// operator says otherwise, and unknown must stay usable — it simply is not chosen for proximity.
const (
	RegionUnknown     = ""
	RegionEUCentral   = "eu-central"
	RegionEUNorth     = "eu-north"
	RegionUSEast      = "us-east"
	RegionUSWest      = "us-west"
	RegionAPSoutheast = "ap-southeast"
)

// OrderedRegions is the same set as a stable list, served to the admin UI so the picker cannot
// drift from what the server accepts. A map has no order and the picker must not reshuffle between
// loads, so the order lives here rather than being derived.
var OrderedRegions = []string{
	RegionUnknown,
	RegionEUCentral,
	RegionEUNorth,
	RegionUSEast,
	RegionUSWest,
	RegionAPSoutheast,
}

// ValidRegions is the set accepted on write. Kept in one place so the admin UI, the request
// validation and the selection in GEO-05 cannot drift apart.
var ValidRegions = map[string]bool{
	RegionUnknown:     true,
	RegionEUCentral:   true,
	RegionEUNorth:     true,
	RegionUSEast:      true,
	RegionUSWest:      true,
	RegionAPSoutheast: true,
}

// ValidateRegion rejects anything outside the set. A bad region is worse than none: an unknown
// region falls through to load-based selection, while a misspelled one looks deliberate.
func ValidateRegion(region string) error {
	if !ValidRegions[region] {
		return fmt.Errorf("unknown region %q", region)
	}
	return nil
}
