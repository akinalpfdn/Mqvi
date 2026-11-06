package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// A lookup that failed says nothing about the invite: telling the user the code is invalid, or the
// server gone, sends them away from an invite that works, and hides the failure.

type inviteLookup struct {
	repository.InviteRepository // nil: any other call panics, which the test would show
	err                         error
}

func (f inviteLookup) GetByCode(_ context.Context, code string) (*models.Invite, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &models.Invite{Code: code, ServerID: "s1"}, nil
}

type serverLookup struct {
	repository.ServerRepository // nil: any other call panics, which the test would show
	err                         error
}

func (f serverLookup) GetActiveByID(_ context.Context, id string) (*models.Server, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &models.Server{ID: id}, nil
}

func (f serverLookup) GetMemberCount(context.Context, string) (int, error) { return 1, nil }

var errInviteDB = errors.New("database is locked")

// isAnswer reports whether err is one of the answers a user is shown about the invite itself.
func isAnswer(err error) bool {
	return errors.Is(err, pkg.ErrBadRequest) || errors.Is(err, pkg.ErrNotFound)
}

func TestInviteValidate_ShouldNotCallTheCodeInvalidWhenALookupFails(t *testing.T) {
	cases := map[string]InviteService{
		"invite lookup": NewInviteService(inviteLookup{err: errInviteDB}, serverLookup{}, nil),
		"server lookup": NewInviteService(inviteLookup{}, serverLookup{err: errInviteDB}, nil),
	}
	for name, svc := range cases {
		if _, err := svc.Validate(context.Background(), "abc"); !errors.Is(err, errInviteDB) || isAnswer(err) {
			t.Errorf("%s failed: answered as %v, want the lookup error", name, err)
		}
	}
}

func TestInviteValidate_ShouldStillRejectAnUnknownCodeAndADeletedServer(t *testing.T) {
	if _, err := NewInviteService(inviteLookup{err: pkg.ErrNotFound}, serverLookup{}, nil).Validate(context.Background(), "abc"); !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("unknown code answered as %v, want bad request", err)
	}
	if _, err := NewInviteService(inviteLookup{}, serverLookup{err: pkg.ErrNotFound}, nil).Validate(context.Background(), "abc"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("deleted server answered as %v, want not found", err)
	}
}

func TestInvitePreview_ShouldNotCallTheCodeInvalidWhenALookupFails(t *testing.T) {
	cases := map[string]InviteService{
		"invite lookup": NewInviteService(inviteLookup{err: errInviteDB}, serverLookup{}, nil),
		"server lookup": NewInviteService(inviteLookup{}, serverLookup{err: errInviteDB}, nil),
	}
	for name, svc := range cases {
		if _, err := svc.GetPreview(context.Background(), "abc"); !errors.Is(err, errInviteDB) || isAnswer(err) {
			t.Errorf("%s failed: answered as %v, want the lookup error", name, err)
		}
	}
}

func TestInvitePreview_ShouldStillAnswer404ForAnUnknownCodeAndADeletedServer(t *testing.T) {
	for name, svc := range map[string]InviteService{
		"unknown code":   NewInviteService(inviteLookup{err: pkg.ErrNotFound}, serverLookup{}, nil),
		"deleted server": NewInviteService(inviteLookup{}, serverLookup{err: pkg.ErrNotFound}, nil),
	} {
		if _, err := svc.GetPreview(context.Background(), "abc"); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("%s answered as %v, want not found", name, err)
		}
	}
}
