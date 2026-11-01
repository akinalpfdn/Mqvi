package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
)

type recordingSearchRepo struct {
	called     bool
	channelIDs []string
}

func (r *recordingSearchRepo) Search(_ context.Context, _ string, _ string, channelIDs []string, _, _ int) (*repository.SearchResult, error) {
	r.called = true
	r.channelIDs = channelIDs
	return &repository.SearchResult{Messages: []models.Message{}}, nil
}

const readBits = models.PermViewChannel | models.PermReadMessages

// newSearchFixture: server srv1 with channels open, noview, noread, admin-only. The caller can view
// and read only "open"; "noview" denies ViewChannel, "noread" denies ReadMessages.
func newSearchFixture(perms map[string]models.Permission) (SearchService, *recordingSearchRepo) {
	repo := &recordingSearchRepo{}
	channels := &testutil.MockChannelRepo{
		GetAllByServerFn: func(_ context.Context, serverID string) ([]models.Channel, error) {
			return []models.Channel{
				{ID: "open", ServerID: serverID},
				{ID: "noview", ServerID: serverID},
				{ID: "noread", ServerID: serverID},
			}, nil
		},
	}
	resolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, _, channelID string) (models.Permission, error) {
			return perms[channelID], nil
		},
	}
	return NewSearchService(repo, channels, resolver, &testutil.MockFileURLSigner{}), repo
}

func TestSearchService_PassesOnlyChannelsTheCallerCanViewAndRead(t *testing.T) {
	svc, repo := newSearchFixture(map[string]models.Permission{
		"open":   readBits,
		"noview": models.PermReadMessages,
		"noread": models.PermViewChannel,
	})

	if _, err := svc.Search(context.Background(), "u1", "srv1", "secret", nil, 25, 0); err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(repo.channelIDs) != 1 || repo.channelIDs[0] != "open" {
		t.Fatalf("searched channels %v, want only [open] — a channel without ViewChannel or ReadMessages was searched", repo.channelIDs)
	}
}

func TestSearchService_RefusesAHiddenChannelNamedExplicitly(t *testing.T) {
	svc, repo := newSearchFixture(map[string]models.Permission{"open": readBits})

	hidden := "noview"
	_, err := svc.Search(context.Background(), "u1", "srv1", "secret", &hidden, 25, 0)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden for an unreadable channel_id", err)
	}
	if repo.called {
		t.Fatal("the repository was queried for a channel the caller cannot read")
	}
}

func TestSearchService_RefusesAChannelOfAnotherServer(t *testing.T) {
	svc, repo := newSearchFixture(map[string]models.Permission{"open": readBits})

	foreign := "elsewhere"
	_, err := svc.Search(context.Background(), "u1", "srv1", "secret", &foreign, 25, 0)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden for a channel not in this server", err)
	}
	if repo.called {
		t.Fatal("the repository was queried for a foreign channel")
	}
}

func TestSearchService_ReadableChannelNamedExplicitlyIsSearchedAlone(t *testing.T) {
	svc, repo := newSearchFixture(map[string]models.Permission{"open": readBits, "noread": readBits})

	ch := "open"
	if _, err := svc.Search(context.Background(), "u1", "srv1", "secret", &ch, 25, 0); err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(repo.channelIDs) != 1 || repo.channelIDs[0] != "open" {
		t.Fatalf("searched %v, want only the named channel", repo.channelIDs)
	}
}

func TestSearchService_ResolveErrorFailsClosed(t *testing.T) {
	repo := &recordingSearchRepo{}
	channels := &testutil.MockChannelRepo{
		GetAllByServerFn: func(_ context.Context, serverID string) ([]models.Channel, error) {
			return []models.Channel{{ID: "open", ServerID: serverID}}, nil
		},
	}
	resolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
			return 0, errors.New("db down")
		},
	}
	svc := NewSearchService(repo, channels, resolver, &testutil.MockFileURLSigner{})

	if _, err := svc.Search(context.Background(), "u1", "srv1", "secret", nil, 25, 0); err == nil {
		t.Fatal("a permission resolve failure returned results instead of an error")
	}
	if repo.called {
		t.Fatal("the repository was queried although permissions could not be resolved")
	}
}
