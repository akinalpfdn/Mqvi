package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/testutil/dbtest"
)

// The count is the leak the old query had beside the rows: even a client that hid foreign rows
// could read "N matches" for a word in a channel it may not open. Both must come from one filter.
func TestSearch_ReturnsOnlyAllowedChannelsAndCountsOnlyThem(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteSearchRepo(f.DB)
	ctx := context.Background()

	srv := f.Server(dbtest.ServerSeed{})
	open := f.Channel("", srv)
	staff := f.Channel("", srv)
	f.Message(dbtest.MessageSeed{ChannelID: open, Content: dbtest.Ptr("secret plan lobby")})
	f.Message(dbtest.MessageSeed{ChannelID: staff, Content: dbtest.Ptr("secret plan staff")})
	f.Message(dbtest.MessageSeed{ChannelID: staff, Content: dbtest.Ptr("secret plan staff two")})

	res, err := repo.Search(ctx, "secret", srv, []string{open}, 25, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if res.TotalCount != 1 {
		t.Errorf("TotalCount = %d, want 1 — matches in a channel outside the allow-list were counted", res.TotalCount)
	}
	if len(res.Messages) != 1 || res.Messages[0].ChannelID != open {
		t.Fatalf("got %d messages (%+v), want only the one in the allowed channel", len(res.Messages), res.Messages)
	}
}

func TestSearch_EmptyAllowListMatchesNothing(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteSearchRepo(f.DB)

	srv := f.Server(dbtest.ServerSeed{})
	ch := f.Channel("", srv)
	f.Message(dbtest.MessageSeed{ChannelID: ch, Content: dbtest.Ptr("findable words")})

	res, err := repo.Search(context.Background(), "findable", srv, nil, 25, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if res.TotalCount != 0 || len(res.Messages) != 0 {
		t.Fatalf("an empty allow-list returned %d messages / count %d; it must mean \"no channel\", not \"every channel\"",
			len(res.Messages), res.TotalCount)
	}
}

// The server filter stays as a second wall: an allow-list naming another server's channel must not
// reach it through this server's route.
func TestSearch_IgnoresAllowedChannelOfAnotherServer(t *testing.T) {
	f := dbtest.New(t)
	repo := NewSQLiteSearchRepo(f.DB)

	mine := f.Server(dbtest.ServerSeed{})
	other := f.Server(dbtest.ServerSeed{})
	foreign := f.Channel("", other)
	f.Message(dbtest.MessageSeed{ChannelID: foreign, Content: dbtest.Ptr("foreign words")})

	res, err := repo.Search(context.Background(), "foreign", mine, []string{foreign}, 25, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if res.TotalCount != 0 || len(res.Messages) != 0 {
		t.Fatalf("a channel of another server was searched through this server (%d results)", len(res.Messages))
	}
}
