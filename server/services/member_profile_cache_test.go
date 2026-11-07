package services

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/testutil"
)

// memberlessServers answers that the user is in no server, so the profile broadcast has nowhere to go.
type memberlessServers struct{ repository.ServerRepository }

func (memberlessServers) GetUserServers(context.Context, string) ([]models.ServerListItem, error) {
	return nil, nil
}

// Typing and voice events carry the profile the hub cached at connect. A rename or a new avatar
// must replace it, or every typing indicator and voice join shows the old one until a reconnect.
func TestUpdateProfile_RefreshesTheProfileTheHubCarriesInEvents(t *testing.T) {
	type cached struct{ userID, username, displayName, avatarURL string }
	var got []cached
	hub := &testutil.MockEventPublisher{
		SetUserInfoFn: func(userID, username, displayName, avatarURL string) {
			got = append(got, cached{userID, username, displayName, avatarURL})
		},
	}
	users := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
			return &models.User{ID: id, Username: "old_name"}, nil
		},
		GetByUsernameFn:            func(context.Context, string) (*models.User, error) { return nil, pkg.ErrNotFound },
		IsUsernamePlatformBannedFn: func(context.Context, string) (bool, error) { return false, nil },
	}
	svc := NewMemberService(
		users, &testutil.MockRoleRepo{}, rosterBanRepo{}, memberlessServers{},
		hub, nil, nil, rosterSigner{},
	)
	username, display, avatar := "new_name", "New Name", "/api/files/avatars/u1/new.png"

	_, err := svc.UpdateProfile(context.Background(), "u1", &models.UpdateProfileRequest{
		Username: &username, DisplayName: &display, AvatarURL: &avatar,
	})

	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	want := cached{"u1", "new_name", "New Name", "/api/files/avatars/u1/new.png"}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("hub profile cache got %+v, want exactly %+v", got, want)
	}
}
