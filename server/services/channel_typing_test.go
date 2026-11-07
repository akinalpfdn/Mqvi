package services

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
)

func channelsInServer(serverID string) *testutil.MockChannelRepo {
	return &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: serverID}, nil
	}}
}

// A typing indicator reaches the channel's readers through one batched read, never one read per
// online member — and never the typist themselves.
func TestChannelTypingRecipients_OneBatchForEveryOnlineMemberAndNotTheTypist(t *testing.T) {
	online := &testutil.MockBroadcastAndOnline{GetOnlineUserIDsForServerFn: func(serverID string) []string {
		if serverID != "srv1" {
			t.Errorf("online members read for server %q", serverID)
		}
		return []string{"typist", "reader", "outsider"}
	}}
	batches := 0
	perms := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: failOnSingle(t),
		FilterUsersWithPermissionFn: func(_ context.Context, _ string, users []string, required models.Permission) ([]string, error) {
			batches++
			if required != models.PermViewChannel|models.PermReadMessages {
				t.Errorf("audience asked for %b", required)
			}
			return slices.DeleteFunc(slices.Clone(users), func(u string) bool { return u == "outsider" }), nil
		},
	}
	router := NewChannelTypingRouter(channelsInServer("srv1"), online, perms)

	got, err := router.TypingRecipients(context.Background(), "typist", "ch1")

	if err != nil || batches != 1 || !slices.Equal(got, []string{"reader"}) {
		t.Fatalf("got %v, %v after %d batches — want only the reader, one batch", got, err, batches)
	}
}

// The channel id comes straight from a client frame: an unreadable channel or audience tells nobody,
// and is returned rather than logged so a flood of bogus ids cannot become a flood of log lines.
func TestChannelTypingRecipients_AnUnreadableChannelOrAudienceTellsNobody(t *testing.T) {
	online := &testutil.MockBroadcastAndOnline{GetOnlineUserIDsForServerFn: func(string) []string { return []string{"u1"} }}
	allowAll := &testutil.MockChannelPermResolver{
		FilterUsersWithPermissionFn: func(_ context.Context, _ string, users []string, _ models.Permission) ([]string, error) {
			return users, nil
		},
	}
	missing := &testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
		return nil, errors.New("not found")
	}}
	if got, err := NewChannelTypingRouter(missing, online, allowAll).TypingRecipients(context.Background(), "typist", "ch1"); got != nil || err == nil {
		t.Fatalf("channel unreadable: told %v, err %v", got, err)
	}

	brokenFilter := &testutil.MockChannelPermResolver{
		FilterUsersWithPermissionFn: func(context.Context, string, []string, models.Permission) ([]string, error) {
			return nil, errors.New("database is locked")
		},
	}
	if got, err := NewChannelTypingRouter(channelsInServer("srv1"), online, brokenFilter).TypingRecipients(context.Background(), "typist", "ch1"); got != nil || err == nil {
		t.Fatalf("audience unreadable: told %v, err %v", got, err)
	}
}
