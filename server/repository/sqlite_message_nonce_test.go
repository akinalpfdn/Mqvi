package repository

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/testutil/dbtest"
)

// The client nonce makes sending idempotent: the same author cannot store two messages under one
// nonce, while other authors and nonce-less messages are unaffected.
func TestMessageClientNonce_OneMessagePerAuthorAndNonce(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteMessageRepo(f.DB)
	channel := f.Channel("", "")
	alice, bob := f.User(""), f.User("")
	nonce := "nonce-0001"
	msg := func(user string, nonce *string) *models.Message {
		return &models.Message{ChannelID: channel, UserID: user, Content: dbtest.Ptr("hi"), ClientNonce: nonce}
	}

	first := msg(alice, &nonce)
	if err := repo.Create(ctx, first); err != nil {
		t.Fatalf("first create: %v", err)
	}
	if err := repo.Create(ctx, msg(alice, &nonce)); !errors.Is(err, ErrDuplicateClientNonce) {
		t.Fatalf("repeat by the same author: err = %v, want ErrDuplicateClientNonce", err)
	}
	if err := repo.Create(ctx, msg(bob, &nonce)); err != nil {
		t.Fatalf("same nonce from another author must be allowed: %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := repo.Create(ctx, msg(alice, nil)); err != nil {
			t.Fatalf("messages without a nonce are never unique-checked: %v", err)
		}
	}

	id, gotChannel, err := repo.GetByAuthorNonce(ctx, alice, nonce)
	if err != nil || id != first.ID || gotChannel != channel {
		t.Fatalf("lookup = (%q, %q, %v), want (%q, %q, nil)", id, gotChannel, err, first.ID, channel)
	}
	if _, _, err := repo.GetByAuthorNonce(ctx, alice, "unknown-nonce"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("unknown nonce: err = %v, want ErrNotFound", err)
	}
}

// Two copies of one send arriving together still store one message: the index decides, not a
// check-then-insert in the service.
func TestMessageClientNonce_ConcurrentCopiesStoreOne(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteMessageRepo(f.DB)
	channel := f.Channel("", "")
	alice := f.User("")
	nonce := "nonce-race-01"

	const copies = 8
	errs := make([]error, copies)
	var wg sync.WaitGroup
	for i := 0; i < copies; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = repo.Create(ctx, &models.Message{ChannelID: channel, UserID: alice, Content: dbtest.Ptr("hi"), ClientNonce: &nonce})
		}(i)
	}
	wg.Wait()

	stored := 0
	for _, err := range errs {
		switch {
		case err == nil:
			stored++
		case errors.Is(err, ErrDuplicateClientNonce):
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	var rows int
	if err := f.DB.QueryRow(`SELECT COUNT(*) FROM messages WHERE client_nonce = ?`, nonce).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if stored != 1 || rows != 1 {
		t.Fatalf("stored %d, rows %d; want exactly one", stored, rows)
	}
}

func TestDMMessageClientNonce_OneMessagePerAuthorAndNonce(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)
	repo := NewSQLiteDMRepo(f.DB)
	alice, bob := f.User(""), f.User("")
	channel := f.DMChannel("", alice, bob)
	nonce := "dm-nonce-01"
	msg := func(user string) *models.DMMessage {
		return &models.DMMessage{DMChannelID: channel, UserID: user, Content: dbtest.Ptr("hi"), ClientNonce: &nonce}
	}

	first := msg(alice)
	if err := repo.CreateMessage(ctx, first); err != nil {
		t.Fatalf("first create: %v", err)
	}
	if err := repo.CreateMessage(ctx, msg(alice)); !errors.Is(err, ErrDuplicateClientNonce) {
		t.Fatalf("repeat by the same author: err = %v, want ErrDuplicateClientNonce", err)
	}
	if err := repo.CreateMessage(ctx, msg(bob)); err != nil {
		t.Fatalf("same nonce from the other participant must be allowed: %v", err)
	}
	id, gotChannel, err := repo.GetMessageByAuthorNonce(ctx, alice, nonce)
	if err != nil || id != first.ID || gotChannel != channel {
		t.Fatalf("lookup = (%q, %q, %v), want (%q, %q, nil)", id, gotChannel, err, first.ID, channel)
	}
}
