package repository

import (
	"context"
	"fmt"
	"testing"

	"github.com/akinalp/mqvi/testutil/dbtest"
)

// Loading history must not skip messages written in the same second as the page boundary.
// created_at is second-precision, so a cursor that compared it alone dropped every older message
// that shared the boundary message's second — on a busy channel, a silent gap in the history.
func TestMessagePages_KeepEveryMessageSentInTheSameSecond(t *testing.T) {
	tests := []struct {
		name      string
		createdAt func(i int) string // when message i was written
	}{
		{"all in one second", func(int) string { return "2026-10-21 12:00:00" }},
		{"pairs per second", func(i int) string { return fmt.Sprintf("2026-10-21 12:00:%02d", i/2) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := dbtest.New(t)
			repo := NewSQLiteMessageRepo(f.DB)
			channel := f.Channel("", "")

			const total = 7
			var inserted []string // oldest first
			for i := 0; i < total; i++ {
				id := f.Message(dbtest.MessageSeed{ChannelID: channel, Content: dbtest.Ptr(fmt.Sprintf("m%d", i))})
				if _, err := f.DB.Exec(`UPDATE messages SET created_at = ? WHERE id = ?`, tt.createdAt(i), id); err != nil {
					t.Fatalf("set created_at: %v", err)
				}
				inserted = append(inserted, id)
			}

			var got []string // newest first, as the API returns it
			before := ""
			for page := 0; page < total; page++ {
				msgs, err := repo.GetByChannelID(context.Background(), channel, before, 3)
				if err != nil {
					t.Fatalf("page %d: %v", page, err)
				}
				if len(msgs) == 0 {
					break
				}
				for _, m := range msgs {
					got = append(got, m.ID)
				}
				before = msgs[len(msgs)-1].ID
			}

			if len(got) != total {
				t.Fatalf("paged through %d messages, want %d: %v", len(got), total, got)
			}
			for i, id := range got {
				if want := inserted[total-1-i]; id != want {
					t.Fatalf("position %d = %s, want %s (newest first, ties in insertion order): %v", i, id, want, got)
				}
			}
		})
	}
}
