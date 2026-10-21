package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/testutil"
)

// quotaLedger records what a request reserved and gave back.
type quotaLedger struct{ reserved, released int64 }

func (q *quotaLedger) storage() *testutil.MockStorageService {
	return &testutil.MockStorageService{
		ReserveFn: func(_ context.Context, _ string, b int64) error { q.reserved += b; return nil },
		ReleaseFn: func(_ context.Context, _ string, b int64) error { q.released += b; return nil },
	}
}

type repeatMessageService struct {
	services.MessageService
	repeat     bool
	gotNonce   string
	broadcasts int
}

func (s *repeatMessageService) Create(_ context.Context, _ string, _ string, req *models.CreateMessageRequest) (*models.Message, bool, error) {
	s.gotNonce = req.ClientNonce
	return &models.Message{ID: "m9", ChannelID: "ch1", Attachments: []models.Attachment{}}, s.repeat, nil
}

func (s *repeatMessageService) BroadcastCreate(*models.Message) { s.broadcasts++ }

type countingUpload struct{ uploads int }

func (u *countingUpload) Upload(context.Context, string, multipart.File, *multipart.FileHeader, bool, *services.ThumbnailUpload) (*models.Attachment, error) {
	u.uploads++
	return &models.Attachment{ID: "a1"}, nil
}

type repeatDMService struct {
	services.DMService
	repeat     bool
	gotNonce   string
	broadcasts int
}

func (s *repeatDMService) SendMessage(_ context.Context, _, _ string, req *models.CreateDMMessageRequest) (*models.DMMessage, bool, error) {
	s.gotNonce = req.ClientNonce
	return &models.DMMessage{ID: "dm9", DMChannelID: "c1", Attachments: []models.DMAttachment{}}, s.repeat, nil
}

func (s *repeatDMService) BroadcastCreate(*models.DMMessage) { s.broadcasts++ }

type countingDMUpload struct{ uploads int }

func (u *countingDMUpload) Upload(context.Context, string, multipart.File, *multipart.FileHeader, bool, *services.ThumbnailUpload) (*models.DMAttachment, error) {
	u.uploads++
	return &models.DMAttachment{ID: "a1"}, nil
}

// multipartSend builds a send with one file and the given client nonce.
func multipartSend(t *testing.T, url, nonce string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("content", "with a file")
	_ = w.WriteField("client_nonce", nonce)
	part, err := w.CreateFormFile("files", "a.txt")
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	_, _ = part.Write([]byte("hello file"))
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, url, &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	return req.WithContext(context.WithValue(req.Context(), ctxkeys.User, &models.User{ID: "u1"}))
}

func TestMessageHandler_RepeatSendAnswersWithoutUploadingOrBroadcasting(t *testing.T) {
	for _, repeat := range []bool{true, false} {
		svc := &repeatMessageService{repeat: repeat}
		upload := &countingUpload{}
		ledger := &quotaLedger{}
		h := NewMessageHandler(svc, upload, ledger.storage(), 10<<20, nil, &testutil.MockFileURLSigner{})

		req := multipartSend(t, "/api/servers/s1/channels/ch1/messages", "nonce-0001")
		req.SetPathValue("serverId", "s1")
		req.SetPathValue("id", "ch1")
		rec := httptest.NewRecorder()
		h.Create(rec, req)

		var body struct {
			Data models.Message `json:"data"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusCreated || body.Data.ID != "m9" || svc.gotNonce != "nonce-0001" {
			t.Fatalf("repeat=%v: status %d, id %q, nonce %q", repeat, rec.Code, body.Data.ID, svc.gotNonce)
		}
		if repeat {
			if upload.uploads != 0 || svc.broadcasts != 0 {
				t.Fatalf("repeat: %d uploads, %d broadcasts; want none — the first request did both", upload.uploads, svc.broadcasts)
			}
			if ledger.reserved == 0 || ledger.released != ledger.reserved {
				t.Fatalf("repeat: reserved %d, released %d; the whole reservation must go back", ledger.reserved, ledger.released)
			}
		} else if upload.uploads != 1 || svc.broadcasts != 1 {
			t.Fatalf("new send: %d uploads, %d broadcasts; want one each", upload.uploads, svc.broadcasts)
		}
	}
}

func TestDMHandler_RepeatSendAnswersWithoutUploadingOrBroadcasting(t *testing.T) {
	for _, repeat := range []bool{true, false} {
		svc := &repeatDMService{repeat: repeat}
		upload := &countingDMUpload{}
		ledger := &quotaLedger{}
		h := NewDMHandler(svc, upload, ledger.storage(), 10<<20, nil, nil, &testutil.MockFileURLSigner{})

		req := multipartSend(t, "/api/dms/c1/messages", "nonce-dm-01")
		req.SetPathValue("channelId", "c1")
		rec := httptest.NewRecorder()
		h.SendMessage(rec, req)

		if rec.Code != http.StatusCreated || svc.gotNonce != "nonce-dm-01" {
			t.Fatalf("repeat=%v: status %d, nonce %q (body %s)", repeat, rec.Code, svc.gotNonce, rec.Body.String())
		}
		if repeat {
			if upload.uploads != 0 || svc.broadcasts != 0 {
				t.Fatalf("repeat: %d uploads, %d broadcasts; want none", upload.uploads, svc.broadcasts)
			}
			if ledger.reserved == 0 || ledger.released != ledger.reserved {
				t.Fatalf("repeat: reserved %d, released %d", ledger.reserved, ledger.released)
			}
		} else if upload.uploads != 1 || svc.broadcasts != 1 {
			t.Fatalf("new send: %d uploads, %d broadcasts; want one each", upload.uploads, svc.broadcasts)
		}
	}
}
