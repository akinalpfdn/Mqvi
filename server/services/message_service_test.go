package services

import (
	"context"
	"errors"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"
)

func newTestMessageService(
	msgRepo *testutil.MockMessageRepo,
	attachRepo *testutil.MockAttachmentRepo,
	chanRepo *testutil.MockChannelRepo,
	userRepo *testutil.MockUserRepo,
	mentionRepo *testutil.MockMentionRepo,
	roleMentionRepo *testutil.MockRoleMentionRepo,
	roleRepo *testutil.MockRoleRepo,
	reactionRepo *testutil.MockReactionRepo,
	hub *testutil.MockBroadcastAndOnline,
	permResolver *testutil.MockChannelPermResolver,
) MessageService {
	return NewMessageService(
		msgRepo, attachRepo, chanRepo, userRepo,
		mentionRepo, roleMentionRepo, roleRepo, reactionRepo,
		&testutil.MockReadStateRepo{},
		hub, permResolver,
		&testutil.MockFileURLSigner{},
	)
}

func TestMessageCreate(t *testing.T) {
	tests := []struct {
		name       string
		content    string
		perms      models.Permission
		wantErr    bool
		errSentinel error
	}{
		{
			name:    "should create message successfully",
			content: "hello world",
			perms:   models.PermSendMessages | models.PermReadMessages,
		},
		{
			name:        "should fail when content is empty",
			content:     "",
			perms:       models.PermSendMessages,
			wantErr:     true,
			errSentinel: pkg.ErrBadRequest,
		},
		{
			name:        "should fail when missing send permission",
			content:     "hello",
			perms:       models.PermReadMessages, // no SendMessages
			wantErr:     true,
			errSentinel: pkg.ErrForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := newTestMessageService(
				&testutil.MockMessageRepo{},
				&testutil.MockAttachmentRepo{},
				&testutil.MockChannelRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
						return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
					},
				},
				&testutil.MockUserRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
						return &models.User{ID: "u1", Username: "alice"}, nil
					},
					GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
						return nil, pkg.ErrNotFound
					},
				},
				&testutil.MockMentionRepo{},
				&testutil.MockRoleMentionRepo{},
				&testutil.MockRoleRepo{},
				&testutil.MockReactionRepo{},
				&testutil.MockBroadcastAndOnline{},
				&testutil.MockChannelPermResolver{
					ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
						return tt.perms, nil
					},
				},
			)

			req := &models.CreateMessageRequest{Content: tt.content}
			msg, err := svc.Create(context.Background(), "ch1", "u1", req)

			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tt.errSentinel != nil && !errors.Is(err, tt.errSentinel) {
					t.Errorf("expected %v, got %v", tt.errSentinel, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if msg.Content == nil || *msg.Content != tt.content {
				t.Errorf("content = %v, want %q", msg.Content, tt.content)
			}
			if msg.Author == nil || msg.Author.ID != "u1" {
				t.Error("author should be populated")
			}
		})
	}
}

func TestMessageCreate_MaxLength(t *testing.T) {
	longContent := make([]byte, models.MaxMessageLength+1)
	for i := range longContent {
		longContent[i] = 'a'
	}

	svc := newTestMessageService(
		&testutil.MockMessageRepo{},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
				return &models.User{ID: "u1"}, nil
			},
			GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
				return nil, pkg.ErrNotFound
			},
		},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages, nil
			},
		},
	)

	req := &models.CreateMessageRequest{Content: string(longContent)}
	_, err := svc.Create(context.Background(), "ch1", "u1", req)
	if err == nil {
		t.Fatal("expected error for content exceeding max length")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("expected ErrBadRequest, got %v", err)
	}
}

func TestMessageGetByChannelID(t *testing.T) {
	tests := []struct {
		name      string
		perms     models.Permission
		dbMsgs    []models.Message
		limit     int
		wantCount int
		wantMore  bool
		wantErr   bool
	}{
		{
			name:  "should return messages with pagination",
			perms: models.PermReadMessages,
			dbMsgs: []models.Message{
				{ID: "m3"}, {ID: "m2"}, {ID: "m1"}, // DESC order from DB
			},
			limit:     2,
			wantCount: 2,
			wantMore:  true,
		},
		{
			name:  "should return all when fewer than limit",
			perms: models.PermReadMessages,
			dbMsgs: []models.Message{
				{ID: "m1"},
			},
			limit:     50,
			wantCount: 1,
			wantMore:  false,
		},
		{
			name:    "should fail without read permission",
			perms:   models.PermSendMessages, // no ReadMessages
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := newTestMessageService(
				&testutil.MockMessageRepo{
					GetByChannelIDFn: func(_ context.Context, _ string, _ string, limit int) ([]models.Message, error) {
						if limit <= len(tt.dbMsgs) {
							return tt.dbMsgs[:limit], nil
						}
						return tt.dbMsgs, nil
					},
				},
				&testutil.MockAttachmentRepo{},
				&testutil.MockChannelRepo{},
				&testutil.MockUserRepo{},
				&testutil.MockMentionRepo{},
				&testutil.MockRoleMentionRepo{},
				&testutil.MockRoleRepo{},
				&testutil.MockReactionRepo{},
				&testutil.MockBroadcastAndOnline{},
				&testutil.MockChannelPermResolver{
					ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
						return tt.perms, nil
					},
				},
			)

			page, err := svc.GetByChannelID(context.Background(), "ch1", "u1", "", tt.limit)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(page.Messages) != tt.wantCount {
				t.Errorf("message count = %d, want %d", len(page.Messages), tt.wantCount)
			}
			if page.HasMore != tt.wantMore {
				t.Errorf("hasMore = %v, want %v", page.HasMore, tt.wantMore)
			}
		})
	}
}

func TestMessageDelete(t *testing.T) {
	tests := []struct {
		name      string
		msgUserID string
		delUserID string
		delPerms  models.Permission
		wantErr   bool
	}{
		{
			name:      "owner can delete own message",
			msgUserID: "u1",
			delUserID: "u1",
			delPerms:  0,
		},
		{
			name:      "admin can delete others message",
			msgUserID: "u1",
			delUserID: "u2",
			delPerms:  models.PermManageMessages,
		},
		{
			name:      "non-owner without permission cannot delete",
			msgUserID: "u1",
			delUserID: "u2",
			delPerms:  0,
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			broadcastCalled := false
			svc := newTestMessageService(
				&testutil.MockMessageRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
						return &models.Message{ID: "m1", UserID: tt.msgUserID, ChannelID: "ch1"}, nil
					},
				},
				&testutil.MockAttachmentRepo{},
				&testutil.MockChannelRepo{},
				&testutil.MockUserRepo{},
				&testutil.MockMentionRepo{},
				&testutil.MockRoleMentionRepo{},
				&testutil.MockRoleRepo{},
				&testutil.MockReactionRepo{},
				&testutil.MockBroadcastAndOnline{
					MockBroadcaster: testutil.MockBroadcaster{
						BroadcastToAllFn: func(_ ws.Event) { broadcastCalled = true },
					},
				},
				&testutil.MockChannelPermResolver{},
			)

			err := svc.Delete(context.Background(), "m1", tt.delUserID, tt.delPerms)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if !errors.Is(err, pkg.ErrForbidden) {
					t.Errorf("expected ErrForbidden, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !broadcastCalled {
				t.Error("delete should broadcast event")
			}
		})
	}
}

func TestMessageUpdate_OnlyOwnerCanEdit(t *testing.T) {
	svc := newTestMessageService(
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", UserID: "u1", ChannelID: "ch1"}, nil
			},
		},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{},
		&testutil.MockUserRepo{},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	req := &models.UpdateMessageRequest{Content: "updated"}
	_, err := svc.Update(context.Background(), "m1", "u2", req)
	if err == nil {
		t.Fatal("expected error when non-owner edits")
	}
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

func TestMessageCreate_E2EE(t *testing.T) {
	cipher := "encrypted-blob"
	deviceID := "dev1"
	svc := newTestMessageService(
		&testutil.MockMessageRepo{},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
				return &models.User{ID: "u1", Username: "alice"}, nil
			},
			GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
				return nil, pkg.ErrNotFound
			},
		},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages, nil
			},
		},
	)

	req := &models.CreateMessageRequest{
		EncryptionVersion: 1,
		Ciphertext:        &cipher,
		SenderDeviceID:    &deviceID,
	}
	msg, err := svc.Create(context.Background(), "ch1", "u1", req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msg.Content != nil {
		t.Error("E2EE message should have nil Content")
	}
	if msg.Ciphertext == nil || *msg.Ciphertext != cipher {
		t.Error("ciphertext should be set")
	}
	if msg.EncryptionVersion != 1 {
		t.Errorf("encryption_version = %d, want 1", msg.EncryptionVersion)
	}
}
