package repository

import (
	"context"
	"sync"
	"testing"

	"github.com/akinalp/mqvi/testutil/dbtest"
)

// The delivery watermark is the double tick: how far a participant's app has received a
// conversation. It only moves forward, ignores messages of other conversations, orders same-second
// messages by rowid, and is not moved by reading.
func TestDMDelivery_Watermark(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteDMRepo(f.DB)
	alice, bob := f.User(""), f.User("")
	ch := f.DMChannel("", alice, bob)
	other := f.DMChannel("", alice, f.User(""))

	// Inserted back to back: all in the same second, told apart by rowid only.
	m1 := f.DMMessage(dbtest.DMMessageSeed{DMChannelID: ch, UserID: alice, Content: dbtest.Ptr("1")})
	m2 := f.DMMessage(dbtest.DMMessageSeed{DMChannelID: ch, UserID: alice, Content: dbtest.Ptr("2")})
	m3 := f.DMMessage(dbtest.DMMessageSeed{DMChannelID: ch, UserID: alice, Content: dbtest.Ptr("3")})
	foreign := f.DMMessage(dbtest.DMMessageSeed{DMChannelID: other, UserID: alice, Content: dbtest.Ptr("x")})

	delivered := func() map[string]bool {
		t.Helper()
		got, err := repo.DeliveredMessageIDs(ctx, bob, ch, []string{m1, m2, m3})
		if err != nil {
			t.Fatalf("DeliveredMessageIDs: %v", err)
		}
		return got
	}

	if got := delivered(); len(got) != 0 {
		t.Fatalf("before any report: %v, want nothing delivered", got)
	}
	if moved, err := repo.MarkDelivered(ctx, bob, ch, foreign); err != nil || moved {
		t.Fatalf("a message of another conversation: moved=%v err=%v, want a no-op", moved, err)
	}

	if moved, err := repo.MarkDelivered(ctx, bob, ch, m2); err != nil || !moved {
		t.Fatalf("mark m2: moved=%v err=%v", moved, err)
	}
	if got := delivered(); !got[m1] || !got[m2] || got[m3] {
		t.Fatalf("after m2: %v, want m1 and m2 only (same second, split by rowid)", got)
	}

	if moved, err := repo.MarkDelivered(ctx, bob, ch, m1); err != nil || moved {
		t.Fatalf("an older report: moved=%v err=%v, want no move", moved, err)
	}
	if moved, err := repo.MarkDelivered(ctx, bob, ch, m2); err != nil || moved {
		t.Fatalf("a repeated report: moved=%v err=%v, want no move", moved, err)
	}

	// Reading is not receiving: a tick that followed reads would tell the sender when their
	// message was read.
	if _, err := repo.MarkRead(ctx, bob, ch, m3); err != nil {
		t.Fatalf("mark read: %v", err)
	}
	if got := delivered(); got[m3] {
		t.Fatalf("after reading m3: %v, want it still undelivered", got)
	}
	mark, err := repo.DeliveryMark(ctx, bob, ch)
	if err != nil || mark == nil || mark.MessageID != m2 {
		t.Fatalf("DeliveryMark = %+v, %v; want m2", mark, err)
	}
}

func TestDMDelivery_NoMarkYet(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteDMRepo(f.DB)
	alice, bob := f.User(""), f.User("")
	ch := f.DMChannel("", alice, bob)

	mark, err := repo.DeliveryMark(context.Background(), bob, ch)
	if err != nil || mark != nil {
		t.Fatalf("DeliveryMark = %+v, %v; want nil, nil", mark, err)
	}
}

// Two devices of the recipient reporting at once end at the later message, whatever the order.
func TestDMDelivery_ConcurrentReportsKeepTheLatest(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteDMRepo(f.DB)
	alice, bob := f.User(""), f.User("")
	ch := f.DMChannel("", alice, bob)
	var ids []string
	for i := 0; i < 8; i++ {
		ids = append(ids, f.DMMessage(dbtest.DMMessageSeed{DMChannelID: ch, UserID: alice, Content: dbtest.Ptr("m")}))
	}

	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if _, err := repo.MarkDelivered(ctx, bob, ch, id); err != nil {
				t.Errorf("mark %s: %v", id, err)
			}
		}(id)
	}
	wg.Wait()

	mark, err := repo.DeliveryMark(ctx, bob, ch)
	if err != nil || mark == nil || mark.MessageID != ids[len(ids)-1] {
		t.Fatalf("DeliveryMark = %+v, %v; want the newest message", mark, err)
	}
}

// After connecting, the app reports conversations it has not downloaded: the newest message.
func TestDMDelivery_LatestMovesToTheNewestMessage(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteDMRepo(f.DB)
	alice, bob := f.User(""), f.User("")
	ch := f.DMChannel("", alice, bob)
	f.DMMessage(dbtest.DMMessageSeed{DMChannelID: ch, UserID: alice, Content: dbtest.Ptr("1")})
	newest := f.DMMessage(dbtest.DMMessageSeed{DMChannelID: ch, UserID: alice, Content: dbtest.Ptr("2")})

	if moved, err := repo.MarkDeliveredLatest(ctx, bob, ch); err != nil || !moved {
		t.Fatalf("first: moved=%v err=%v", moved, err)
	}
	if moved, err := repo.MarkDeliveredLatest(ctx, bob, ch); err != nil || moved {
		t.Fatalf("repeat: moved=%v err=%v, want no move", moved, err)
	}
	mark, err := repo.DeliveryMark(ctx, bob, ch)
	if err != nil || mark == nil || mark.MessageID != newest {
		t.Fatalf("DeliveryMark = %+v, %v; want the newest", mark, err)
	}
}
