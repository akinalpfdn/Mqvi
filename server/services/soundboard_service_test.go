package services

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// buildWavHeader writes a canonical WAV header (RIFF/fmt/data) for the given
// format and data size. No PCM payload is needed — wavDurationMs reads only the
// data chunk's declared size, not its bytes.
func buildWavHeader(sampleRate, channels, bits, dataSize uint32) []byte {
	byteRate := sampleRate * channels * (bits / 8)
	blockAlign := uint16(channels * (bits / 8))
	buf := new(bytes.Buffer)
	buf.WriteString("RIFF")
	_ = binary.Write(buf, binary.LittleEndian, uint32(36+dataSize))
	buf.WriteString("WAVE")
	buf.WriteString("fmt ")
	_ = binary.Write(buf, binary.LittleEndian, uint32(16))
	_ = binary.Write(buf, binary.LittleEndian, uint16(1)) // PCM
	_ = binary.Write(buf, binary.LittleEndian, uint16(channels))
	_ = binary.Write(buf, binary.LittleEndian, sampleRate)
	_ = binary.Write(buf, binary.LittleEndian, byteRate)
	_ = binary.Write(buf, binary.LittleEndian, blockAlign)
	_ = binary.Write(buf, binary.LittleEndian, uint16(bits))
	buf.WriteString("data")
	_ = binary.Write(buf, binary.LittleEndian, dataSize)
	return buf.Bytes()
}

func TestWavDurationMs(t *testing.T) {
	// 48kHz mono 16-bit → 96000 bytes/sec.
	const byteRate = 48000 * 1 * 2
	cases := []struct {
		name     string
		dataSize uint32
		wantMs   int
	}{
		{"1s", byteRate, 1000},
		{"7s cap", byteRate * 7, 7000},
		{"8s over cap", byteRate * 8, 8000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rs := bytes.NewReader(buildWavHeader(48000, 1, 16, tc.dataSize))
			got, err := wavDurationMs(rs)
			if err != nil {
				t.Fatalf("wavDurationMs: %v", err)
			}
			if got != tc.wantMs {
				t.Errorf("duration = %d ms, want %d", got, tc.wantMs)
			}
		})
	}

	t.Run("rejects non-WAV input", func(t *testing.T) {
		rs := bytes.NewReader([]byte("this is definitely not a wav file"))
		if _, err := wavDurationMs(rs); err == nil {
			t.Error("expected an error for non-WAV input")
		}
	})

	// Anti-bypass: 8s of PCM but with the stored byteRate inflated so a naive
	// dataSize/byteRate would look short. Must be rejected (inconsistent header).
	t.Run("rejects inflated/inconsistent byteRate", func(t *testing.T) {
		hdr := buildWavHeader(48000, 1, 16, byteRate*8) // 8 seconds of data
		binary.LittleEndian.PutUint32(hdr[28:32], byteRate*8) // tamper stored byteRate
		rs := bytes.NewReader(hdr)
		if _, err := wavDurationMs(rs); err == nil {
			t.Error("expected rejection of inconsistent byteRate (bypass attempt)")
		}
	})

	// Anti-DoS: a tiny file declaring a huge fmt chunk size must be rejected
	// before any large allocation. fmt chunk size field is at byte offset 16.
	t.Run("rejects oversized fmt chunk size", func(t *testing.T) {
		hdr := buildWavHeader(48000, 1, 16, byteRate)
		binary.LittleEndian.PutUint32(hdr[16:20], 0xFFFFFFFF)
		rs := bytes.NewReader(hdr)
		if _, err := wavDurationMs(rs); err == nil {
			t.Error("expected rejection of oversized fmt chunk size")
		}
	})
}
