package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/testutil"
)

// deliveredDMService records the reports that reach the service.
type deliveredDMService struct {
	services.DMService
	calls []string // "user|channel|message"
}

func (s *deliveredDMService) MarkDelivered(_ context.Context, userID, channelID, messageID string) error {
	s.calls = append(s.calls, userID+"|"+channelID+"|"+messageID)
	return nil
}

func TestDMHandler_MarkDelivered(t *testing.T) {
	cases := []struct {
		name      string
		body      string
		wantCode  int
		wantCalls int
	}{
		{"a message id is stored for the signed-in user", `{"message_id":"m2"}`, http.StatusNoContent, 1},
		{"no message id is refused", `{}`, http.StatusBadRequest, 0},
		{"a body that is not JSON is refused", `not json`, http.StatusBadRequest, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &deliveredDMService{}
			h := NewDMHandler(svc, nil, nil, 10<<20, nil, nil, &testutil.MockFileURLSigner{})
			req := httptest.NewRequest(http.MethodPost, "/api/dms/channels/c1/delivered", strings.NewReader(tc.body))
			req.SetPathValue("channelId", "c1")
			req = req.WithContext(context.WithValue(req.Context(), ctxkeys.User, &models.User{ID: "bob"}))
			rec := httptest.NewRecorder()

			h.MarkDelivered(rec, req)

			if rec.Code != tc.wantCode || len(svc.calls) != tc.wantCalls {
				t.Fatalf("status %d, %d calls; want %d, %d", rec.Code, len(svc.calls), tc.wantCode, tc.wantCalls)
			}
			// The reporter is whoever is signed in — never an id from the request.
			if tc.wantCalls == 1 && svc.calls[0] != "bob|c1|m2" {
				t.Fatalf("service got %q", svc.calls[0])
			}
		})
	}
}
