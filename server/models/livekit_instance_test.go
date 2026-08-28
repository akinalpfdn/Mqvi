package models

import "testing"

// A bad region is worse than none: unknown falls through to load-based selection and stays usable,
// while a misspelled one looks deliberate and quietly matches nobody.

func TestValidateRegion_AcceptsTheClosedSet(t *testing.T) {
	for _, r := range []string{RegionUnknown, RegionEUCentral, RegionEUNorth, RegionUSEast, RegionUSWest, RegionAPSoutheast} {
		if err := ValidateRegion(r); err != nil {
			t.Errorf("region %q rejected: %v", r, err)
		}
	}
}

func TestValidateRegion_RejectsAnythingElse(t *testing.T) {
	for _, r := range []string{"eu_central", "EU-CENTRAL", "canada", "us-east ", "🇹🇷"} {
		if err := ValidateRegion(r); err == nil {
			t.Errorf("region %q accepted — a typo becomes an instance that serves nobody", r)
		}
	}
}

func TestCreateRequest_TrimsAndValidatesRegion(t *testing.T) {
	req := &CreateLiveKitInstanceRequest{URL: "wss://x", APIKey: "k", APISecret: "s", Region: "  us-east  "}
	if err := req.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if req.Region != RegionUSEast {
		t.Errorf("region = %q, want trimmed %q", req.Region, RegionUSEast)
	}
}

func TestCreateRequest_RejectsAnUnknownRegion(t *testing.T) {
	req := &CreateLiveKitInstanceRequest{URL: "wss://x", APIKey: "k", APISecret: "s", Region: "atlantis"}
	if err := req.Validate(); err == nil {
		t.Fatal("an unknown region was accepted at creation")
	}
}

func TestUpdateRequest_ValidatesRegionOnlyWhenGiven(t *testing.T) {
	// nil means "leave it alone" and must not be treated as empty.
	if err := (&UpdateLiveKitInstanceRequest{}).Validate(); err != nil {
		t.Fatalf("omitted region rejected: %v", err)
	}
	bad := "atlantis"
	if err := (&UpdateLiveKitInstanceRequest{Region: &bad}).Validate(); err == nil {
		t.Error("an unknown region was accepted on update")
	}
}
