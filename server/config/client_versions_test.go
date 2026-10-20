package config

import "testing"

func TestParseClientVersion(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    string
		wantErr bool
	}{
		{"unset means no minimum", "", "", false},
		{"major only", "2", "2", false},
		{"major.minor", "1.2", "1.2", false},
		{"full version", "1.10.3", "1.10.3", false},
		{"surrounding spaces", " 1.1.0 ", "1.1.0", false},
		{"leading v", "v1.1.0", "", true},
		{"four parts", "1.1.0.4", "", true},
		{"pre-release tag", "1.1.0-beta", "", true},
		{"words", "latest", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("MQVI_TEST_MIN_VERSION", tt.value)
			got, err := parseClientVersion("MQVI_TEST_MIN_VERSION")
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
