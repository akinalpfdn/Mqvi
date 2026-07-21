package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// The encryption rule is one rule, and every mutating path has to apply it. It shipped on create and
// not on edit, and the edit path stayed open through a whole review round — a per-path table is what
// makes a missing one visible instead of a matter of remembering.
func TestEncryptionPolicy_EveryDirectionOnEveryPath(t *testing.T) {
	cases := []struct {
		name            string
		serverEncrypted bool
		version         int
		wantCode        string
	}{
		{"plaintext on a plaintext server", false, 0, ""},
		{"encrypted on an encrypted server", true, 1, ""},
		{"plaintext on an encrypted server", true, 0, pkg.CodeEncryptionRequired},
		{"encrypted on a plaintext server", false, 1, pkg.CodeEncryptionNotAvailable},
	}

	for _, tc := range cases {
		t.Run("channel/"+tc.name, func(t *testing.T) {
			svc := &messageService{serverReader: stubServerEncryption{e2ee: tc.serverEncrypted}}
			err := svc.enforceServerEncryptionPolicy(context.Background(), "s1", tc.version)
			assertPolicy(t, err, tc.wantCode)
		})

		t.Run("dm/"+tc.name, func(t *testing.T) {
			ch := &models.DMChannel{E2EEEnabled: tc.serverEncrypted}
			assertPolicy(t, enforceDMEncryptionPolicy(ch, tc.version), tc.wantCode)
		})
	}
}

func assertPolicy(t *testing.T, err error, wantCode string) {
	t.Helper()
	if wantCode == "" {
		if err != nil {
			t.Fatalf("expected the message to be allowed, got %v", err)
		}
		return
	}
	if err == nil {
		t.Fatal("expected the message to be refused, got nil")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("want ErrBadRequest, got %v", err)
	}
	if got := pkg.CodeOf(err); got != wantCode {
		t.Errorf("code = %q, want %q — the client maps this to the reason it shows", got, wantCode)
	}
}
