package config

import "testing"

func TestNormalizeCertFingerprintsUppercasesAndTrims(t *testing.T) {
	// keytool prints uppercase, but a fingerprint copied out of a chat message or a shell
	// variable can arrive lowercase or padded. Android matches on the hex bytes, not the case.
	got, err := normalizeCertFingerprints([]string{
		" 5f:77:05:67:18:c3:4f:77:be:d8:41:67:bf:a8:46:f1:ca:7e:37:75:c4:7f:0d:fd:30:b7:30:60:9e:74:fc:ef ",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := "5F:77:05:67:18:C3:4F:77:BE:D8:41:67:BF:A8:46:F1:CA:7E:37:75:C4:7F:0D:FD:30:B7:30:60:9E:74:FC:EF"
	if len(got) != 1 || got[0] != want {
		t.Errorf("got %v, want [%s]", got, want)
	}
}

func TestNormalizeCertFingerprintsRejectsMalformed(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"sha-1, not sha-256", "5F:77:05:67:18:C3:4F:77:BE:D8:41:67:BF:A8:46:F1:CA:7E:37:75"},
		{"no colons", "5F770567 18C34F77BED84167BFA846F1CA7E3775C47F0DFD30B730609E74FCEF"},
		{"not hex", "ZZ:77:05:67:18:C3:4F:77:BE:D8:41:67:BF:A8:46:F1:CA:7E:37:75:C4:7F:0D:FD:30:B7:30:60:9E:74:FC:EF"},
		{"one byte short", "77:05:67:18:C3:4F:77:BE:D8:41:67:BF:A8:46:F1:CA:7E:37:75:C4:7F:0D:FD:30:B7:30:60:9E:74:FC:EF"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// A bad fingerprint has no runtime symptom — Android just quietly keeps opening
			// links in the browser. Boot must fail instead.
			if _, err := normalizeCertFingerprints([]string{tt.input}); err == nil {
				t.Errorf("accepted malformed fingerprint %q", tt.input)
			}
		})
	}
}

func TestNormalizeCertFingerprintsAllowsEmpty(t *testing.T) {
	// Unset is a valid state: App Links are simply off (self-host, dev, staging).
	got, err := normalizeCertFingerprints(splitCSV(""))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %v, want empty", got)
	}
}
