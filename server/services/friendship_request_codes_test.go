package services

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// Only the lookups SendRequest makes before it refuses; anything else would nil-panic.
type codesUserRepo struct {
	repository.UserRepository
	users map[string]*models.User
}

func (r *codesUserRepo) GetActiveByUsername(_ context.Context, username string) (*models.User, error) {
	if u, ok := r.users[username]; ok {
		return u, nil
	}
	return nil, pkg.ErrNotFound
}

type codesFriendRepo struct {
	repository.FriendshipRepository
	existing *models.Friendship
}

func (r *codesFriendRepo) GetByPair(context.Context, string, string) (*models.Friendship, error) {
	if r.existing == nil {
		return nil, pkg.ErrNotFound
	}
	return r.existing, nil
}

// The client words each refusal itself, so each must carry its code — never just server text.
func TestSendRequest_RefusalsCarryACodeTheClientCanWord(t *testing.T) {
	users := map[string]*models.User{
		"me":  {ID: "u-me", Username: "me"},
		"bob": {ID: "u-bob", Username: "bob"},
	}
	tests := []struct {
		name     string
		username string
		existing *models.Friendship
		want     string
	}{
		{"an empty username", "", nil, pkg.CodeFriendInvalidUsername},
		{"nobody by that name", "ghost", nil, pkg.CodeFriendUserNotFound},
		{"yourself", "me", nil, pkg.CodeFriendSelf},
		{"already friends", "bob", &models.Friendship{UserID: "u-me", FriendID: "u-bob", Status: models.FriendshipStatusAccepted}, pkg.CodeFriendAlreadyFriends},
		{"a request already sent", "bob", &models.Friendship{UserID: "u-me", FriendID: "u-bob", Status: models.FriendshipStatusPending}, pkg.CodeFriendRequestPending},
		{"someone who blocked you looks like nobody", "bob", &models.Friendship{UserID: "u-bob", FriendID: "u-me", Status: models.FriendshipStatusBlocked}, pkg.CodeFriendUserNotFound},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewFriendshipService(&codesFriendRepo{existing: tc.existing}, &codesUserRepo{users: users}, nil, fakeURLSigner{})

			_, err := svc.SendRequest(context.Background(), "u-me", &models.SendFriendRequestRequest{Username: tc.username})

			if got := pkg.CodeOf(err); got != tc.want {
				t.Fatalf("code = %q, want %q (err=%v)", got, tc.want, err)
			}
		})
	}
}
