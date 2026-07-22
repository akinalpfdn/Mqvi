package models

import (
	"strings"
	"testing"
)

type validatable interface{ Validate() error }

// Local rather than testutil.Ptr: testutil imports repository, repository imports models, so a
// models test that reached for it would close an import cycle.
func ptr(s string) *string { return &s }

// An encrypted message is only readable if the recipient can tell which device sent it: the client
// picks the session or sender key by sender_device_id, and skips any message that has none. A row
// with a ciphertext and no device id is stored, broadcast, and never decrypted by anyone.
//
// Create demanded it from the start. Edit did not, and the service copies the request's value onto
// the row unconditionally — so an edit that omitted the field wrote NULL over a good one and turned
// a readable message into permanent noise. Both paths, both surfaces, one rule.
func TestEncryptedMessage_RequiresWhatDecryptionNeeds(t *testing.T) {
	cases := []struct {
		name    string
		build   func(ciphertext, deviceID *string) validatable
		surface string
	}{
		{"channel create", func(c, d *string) validatable {
			return &CreateMessageRequest{EncryptionVersion: 1, Ciphertext: c, SenderDeviceID: d}
		}, "CreateMessageRequest"},
		{"channel edit", func(c, d *string) validatable {
			return &UpdateMessageRequest{EncryptionVersion: 1, Ciphertext: c, SenderDeviceID: d}
		}, "UpdateMessageRequest"},
		{"dm send", func(c, d *string) validatable {
			return &CreateDMMessageRequest{EncryptionVersion: 1, Ciphertext: c, SenderDeviceID: d}
		}, "CreateDMMessageRequest"},
		{"dm edit", func(c, d *string) validatable {
			return &UpdateDMMessageRequest{EncryptionVersion: 1, Ciphertext: c, SenderDeviceID: d}
		}, "UpdateDMMessageRequest"},
	}

	for _, tc := range cases {
		t.Run(tc.name+"/accepts a complete encrypted message", func(t *testing.T) {
			if err := tc.build(ptr("CIPHER"), ptr("dev1")).Validate(); err != nil {
				t.Errorf("%s refused a complete encrypted message: %v", tc.surface, err)
			}
		})

		t.Run(tc.name+"/refuses a missing ciphertext", func(t *testing.T) {
			if err := tc.build(nil, ptr("dev1")).Validate(); err == nil {
				t.Errorf("%s accepted an encrypted message with no ciphertext", tc.surface)
			}
			if err := tc.build(ptr(""), ptr("dev1")).Validate(); err == nil {
				t.Errorf("%s accepted an empty ciphertext", tc.surface)
			}
		})

		t.Run(tc.name+"/refuses a missing sender device", func(t *testing.T) {
			if err := tc.build(ptr("CIPHER"), nil).Validate(); err == nil {
				t.Errorf(
					"%s accepted an encrypted message with no sender_device_id — every recipient skips it, "+
						"so the message is stored and never readable", tc.surface,
				)
			}
			if err := tc.build(ptr("CIPHER"), ptr("")).Validate(); err == nil {
				t.Errorf("%s accepted an empty sender_device_id", tc.surface)
			}
		})
	}
}

// Plaintext bounds. The cap is the only thing standing between a message field and unbounded
// storage, and trimming is what stops a message of spaces counting as content.
func TestPlaintextMessage_TrimsAndEnforcesTheCap(t *testing.T) {
	t.Run("should refuse content that is only whitespace", func(t *testing.T) {
		for _, r := range []validatable{
			&CreateMessageRequest{Content: "   \t\n  "},
			&UpdateMessageRequest{Content: "   \t\n  "},
			&CreateDMMessageRequest{Content: "   \t\n  "},
			&UpdateDMMessageRequest{Content: "   \t\n  "},
		} {
			if err := r.Validate(); err == nil {
				t.Errorf("%T accepted a message of nothing but whitespace", r)
			}
		}
	})

	t.Run("should accept content exactly on the cap", func(t *testing.T) {
		exact := strings.Repeat("a", MaxMessageLength)
		if err := (&CreateMessageRequest{Content: exact}).Validate(); err != nil {
			t.Errorf("a message exactly at the cap was refused: %v", err)
		}
	})

	t.Run("should refuse content one rune over the cap", func(t *testing.T) {
		over := strings.Repeat("a", MaxMessageLength+1)
		for _, r := range []validatable{
			&CreateMessageRequest{Content: over},
			&UpdateMessageRequest{Content: over},
			&CreateDMMessageRequest{Content: over},
			&UpdateDMMessageRequest{Content: over},
		} {
			if err := r.Validate(); err == nil {
				t.Errorf("%T accepted a message one rune over the cap", r)
			}
		}
	})

	// The cap counts runes, not bytes. Counting bytes would reject a message of emoji or Turkish
	// text at a quarter of the advertised length.
	t.Run("should measure the cap in runes rather than bytes", func(t *testing.T) {
		multibyte := strings.Repeat("ğ", MaxMessageLength)
		if err := (&CreateMessageRequest{Content: multibyte}).Validate(); err != nil {
			t.Errorf("a message of %d multi-byte runes was refused: %v", MaxMessageLength, err)
		}
	})

	// A photo with no caption is a normal message on send. There is nothing to attach on an edit,
	// so that exemption deliberately does not exist there.
	t.Run("should allow empty content when files are attached", func(t *testing.T) {
		if err := (&CreateMessageRequest{HasFiles: true}).Validate(); err != nil {
			t.Errorf("a file-only message was refused: %v", err)
		}
		if err := (&CreateDMMessageRequest{HasFiles: true}).Validate(); err != nil {
			t.Errorf("a file-only DM was refused: %v", err)
		}
	})

	// Validate mutates the request it is called on; the handler passes that same struct to the
	// service, so untrimmed content would be what got stored.
	t.Run("should trim the content it validates", func(t *testing.T) {
		r := &CreateMessageRequest{Content: "  hello  "}
		if err := r.Validate(); err != nil {
			t.Fatalf("validate: %v", err)
		}
		if r.Content != "hello" {
			t.Errorf("content = %q, want %q — the stored message keeps whatever this leaves", r.Content, "hello")
		}
	})
}
