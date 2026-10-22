package handlers

import (
	"context"
	"mime/multipart"
	"net/http/httptest"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/testutil"
)

// A client that hung up mid-upload is the usual cause of an upload failing. The cleanup that
// removes the half-sent message must not run on that cancelled context, or it fails too and leaves
// a message without its files — which a retry under the same nonce then returns as sent.

type failingUpload struct{}

func (failingUpload) Upload(context.Context, string, multipart.File, *multipart.FileHeader, bool, *services.ThumbnailUpload) (*models.Attachment, error) {
	return nil, context.Canceled
}

type failingDMUpload struct{}

func (failingDMUpload) Upload(context.Context, string, multipart.File, *multipart.FileHeader, bool, *services.ThumbnailUpload) (*models.DMAttachment, error) {
	return nil, context.Canceled
}

type cleanupMessageService struct {
	repeatMessageService
	deleteCtxErr error
	deleted      bool
}

func (s *cleanupMessageService) Delete(ctx context.Context, _, _, _ string, _ models.Permission) error {
	s.deleted = true
	s.deleteCtxErr = ctx.Err()
	return ctx.Err()
}

type cleanupDMService struct {
	repeatDMService
	deleteCtxErr error
	deleted      bool
}

func (s *cleanupDMService) DeleteMessage(ctx context.Context, _, _ string) error {
	s.deleted = true
	s.deleteCtxErr = ctx.Err()
	return ctx.Err()
}

func TestUploadFailureCleanup_SurvivesTheClientHangingUp(t *testing.T) {
	t.Run("channel", func(t *testing.T) {
		svc := &cleanupMessageService{}
		ledger := &quotaLedger{}
		h := NewMessageHandler(svc, failingUpload{}, ledger.storage(), 10<<20, nil, &testutil.MockFileURLSigner{})
		req := multipartSend(t, "/api/servers/s1/channels/ch1/messages", "nonce-0001")
		req.SetPathValue("serverId", "s1")
		req.SetPathValue("id", "ch1")
		ctx, cancel := context.WithCancel(req.Context())
		cancel()

		h.Create(httptest.NewRecorder(), req.WithContext(ctx))

		if !svc.deleted || svc.deleteCtxErr != nil {
			t.Fatalf("cleanup ran=%v on a context with err=%v; want it run on a live context", svc.deleted, svc.deleteCtxErr)
		}
		if ledger.released != ledger.reserved {
			t.Fatalf("reserved %d, released %d; the reservation must come back", ledger.reserved, ledger.released)
		}
	})

	t.Run("dm", func(t *testing.T) {
		svc := &cleanupDMService{}
		ledger := &quotaLedger{}
		h := NewDMHandler(svc, failingDMUpload{}, ledger.storage(), 10<<20, nil, nil, nil, &testutil.MockFileURLSigner{})
		req := multipartSend(t, "/api/dms/c1/messages", "nonce-dm-01")
		req.SetPathValue("channelId", "c1")
		ctx, cancel := context.WithCancel(req.Context())
		cancel()

		h.SendMessage(httptest.NewRecorder(), req.WithContext(ctx))

		if !svc.deleted || svc.deleteCtxErr != nil {
			t.Fatalf("cleanup ran=%v on a context with err=%v; want it run on a live context", svc.deleted, svc.deleteCtxErr)
		}
	})
}
