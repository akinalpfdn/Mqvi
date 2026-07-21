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
		&testutil.MockFileDeleter{},
		&testutil.MockStorageService{},
		stubServerEncryption{},
	)
}

// stubServerEncryption answers the one question the message path asks about a server. Defaults to
// an unencrypted server so the existing plaintext cases behave as before.
type stubServerEncryption struct{ e2ee bool }

func (s stubServerEncryption) IsE2EEEnabled(_ context.Context, _ string) (bool, error) {
	return s.e2ee, nil
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
				&testutil.MockChannelRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
						return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
					},
				},
				&testutil.MockUserRepo{},
				&testutil.MockMentionRepo{},
				&testutil.MockRoleMentionRepo{},
				&testutil.MockRoleRepo{},
				&testutil.MockReactionRepo{},
				&testutil.MockBroadcastAndOnline{
					MockBroadcaster: testutil.MockBroadcaster{
						BroadcastToUsersFn: func(_ []string, _ ws.Event) { broadcastCalled = true },
					},
					GetOnlineUserIDsForServerFn: func(_ string) []string {
						return []string{"u1", "u2"}
					},
				},
				&testutil.MockChannelPermResolver{
					ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
						return models.PermViewChannel | models.PermReadMessages, nil
					},
				},
			)

			err := svc.Delete(context.Background(), "srv1", "m1", tt.delUserID, tt.delPerms)
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

func TestMessageDelete_CrossServerDenied(t *testing.T) {
	// The message's channel is in "srv1"; deleting via a different server's route must
	// be forbidden even for the message owner with ManageMessages (IDOR-1 guard).
	svc := newTestMessageService(
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", UserID: "u1", ChannelID: "ch1"}, nil
			},
		},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	err := svc.Delete(context.Background(), "other-srv", "m1", "u1", models.PermManageMessages)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("cross-server delete should be forbidden, got %v", err)
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

// markingSigner appends a marker so a test can tell a signed URL from an unsigned one — the shared
// MockFileURLSigner is a no-op and cannot.
type markingSigner struct{}

func (markingSigner) SignURL(fileURL string) string {
	if fileURL == "" {
		return fileURL
	}
	return fileURL + "?sig"
}

func (markingSigner) SignURLPtr(fileURL *string) *string {
	if fileURL == nil || *fileURL == "" {
		return fileURL
	}
	signed := *fileURL + "?sig"
	return &signed
}

// A thumbnail is served from the same signature-gated endpoint as its original, so it must be
// signed at every egress the original is. It was not, which returned 401 for every thumbnail on
// cross-origin clients (Electron, mobile) where the cookie fallback does not apply.
func TestGetByChannelID_SignsAttachmentThumbURL(t *testing.T) {
	thumb := "/api/files/messages/ch1/abcd_thumb.webp"
	svc := NewMessageService(
		&testutil.MockMessageRepo{
			GetByChannelIDFn: func(_ context.Context, _ string, _ string, _ int) ([]models.Message, error) {
				return []models.Message{{ID: "m1", ChannelID: "ch1", UserID: "u1"}}, nil
			},
		},
		&testutil.MockAttachmentRepo{
			GetByMessageIDsFn: func(_ context.Context, _ []string) ([]models.Attachment, error) {
				return []models.Attachment{{
					ID:        "a1",
					MessageID: "m1",
					FileURL:   "/api/files/messages/ch1/abcd.bin",
					ThumbURL:  &thumb,
				}}, nil
			},
		},
		&testutil.MockChannelRepo{},
		&testutil.MockUserRepo{},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockReadStateRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermReadMessages, nil
			},
		},
		markingSigner{},
		&testutil.MockFileDeleter{},
		&testutil.MockStorageService{},
		stubServerEncryption{},
	)

	page, err := svc.GetByChannelID(context.Background(), "ch1", "u1", "", 50)
	if err != nil {
		t.Fatalf("GetByChannelID: %v", err)
	}
	if len(page.Messages) != 1 || len(page.Messages[0].Attachments) != 1 {
		t.Fatalf("expected 1 message with 1 attachment, got %+v", page.Messages)
	}

	att := page.Messages[0].Attachments[0]
	if att.FileURL != "/api/files/messages/ch1/abcd.bin?sig" {
		t.Errorf("file_url not signed: %q", att.FileURL)
	}
	if att.ThumbURL == nil || *att.ThumbURL != thumb+"?sig" {
		t.Errorf("thumb_url not signed: %v", att.ThumbURL)
	}
}

// The client alone decides whether to encrypt, so a client that misreads the server's state would
// store a message in the clear on a server that mandates E2EE. The server must refuse it.
func TestCreate_RejectsPlaintextOnEncryptedServer(t *testing.T) {
	newSvc := func(e2ee bool) MessageService {
		return NewMessageService(
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
			},
			&testutil.MockMentionRepo{},
			&testutil.MockRoleMentionRepo{},
			&testutil.MockRoleRepo{},
			&testutil.MockReactionRepo{},
			&testutil.MockReadStateRepo{},
			&testutil.MockBroadcastAndOnline{},
			&testutil.MockChannelPermResolver{
				ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
					return models.PermSendMessages | models.PermReadMessages, nil
				},
			},
			&testutil.MockFileURLSigner{},
			&testutil.MockFileDeleter{},
			&testutil.MockStorageService{},
			stubServerEncryption{e2ee: e2ee},
		)
	}

	t.Run("should reject a plaintext message when the server requires encryption", func(t *testing.T) {
		_, err := newSvc(true).Create(context.Background(), "ch1", "u1", &models.CreateMessageRequest{Content: "hello"})
		if !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("want ErrBadRequest, got %v", err)
		}
	})

	t.Run("should accept a plaintext message when the server does not require encryption", func(t *testing.T) {
		if _, err := newSvc(false).Create(context.Background(), "ch1", "u1", &models.CreateMessageRequest{Content: "hello"}); err != nil {
			t.Fatalf("plaintext on an unencrypted server should be allowed: %v", err)
		}
	})
}

// An edit writes `content` without touching encryption_version or ciphertext, so a plaintext edit of
// an encrypted message would leave readable text sitting beside the ciphertext the UI still renders
// — a silent leak with no visible symptom. Create was guarded; Update has to be too.
func TestUpdate_RejectsPlaintextOnEncryptedServer(t *testing.T) {
	newSvc := func(e2ee bool) MessageService {
		return NewMessageService(
			&testutil.MockMessageRepo{
				GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
					return &models.Message{ID: id, ChannelID: "ch1", UserID: "u1", EncryptionVersion: 1}, nil
				},
			},
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
			&testutil.MockReadStateRepo{},
			&testutil.MockBroadcastAndOnline{},
			&testutil.MockChannelPermResolver{},
			&testutil.MockFileURLSigner{},
			&testutil.MockFileDeleter{},
			&testutil.MockStorageService{},
			stubServerEncryption{e2ee: e2ee},
		)
	}

	t.Run("should reject a plaintext edit when the server requires encryption", func(t *testing.T) {
		_, err := newSvc(true).Update(context.Background(), "m1", "u1", &models.UpdateMessageRequest{Content: "leaked"})
		if !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("want ErrBadRequest, got %v", err)
		}
		if pkg.CodeOf(err) != pkg.CodeEncryptionRequired {
			t.Errorf("want code %q so the client can explain itself, got %q", pkg.CodeEncryptionRequired, pkg.CodeOf(err))
		}
	})

	t.Run("should allow a plaintext edit when the server does not require encryption", func(t *testing.T) {
		if _, err := newSvc(false).Update(context.Background(), "m1", "u1", &models.UpdateMessageRequest{Content: "fine"}); err != nil {
			t.Fatalf("plaintext edit on an unencrypted server should be allowed: %v", err)
		}
	})
}
