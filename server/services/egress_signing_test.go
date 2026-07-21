package services

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
)

// urlFields returns the names of every field on a model that carries a file URL.
//
// Driven by the model rather than a hand-listed set: a URL field added later is picked up here
// automatically, which is the whole point. thumb_url shipped unsigned precisely because the list of
// things to sign lived in five call sites and nobody's head.
func urlFields(v any) []string {
	t := reflect.TypeOf(v)
	if t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	var out []string
	for i := 0; i < t.NumField(); i++ {
		name := t.Field(i).Name
		if strings.HasSuffix(name, "URL") {
			out = append(out, name)
		}
	}
	return out
}

// fieldString reads a string or *string field by name, reporting whether it was set at all.
func fieldString(v any, name string) (string, bool) {
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Ptr {
		rv = rv.Elem()
	}
	f := rv.FieldByName(name)
	switch f.Kind() {
	case reflect.String:
		return f.String(), f.String() != ""
	case reflect.Ptr:
		if f.IsNil() {
			return "", false
		}
		return f.Elem().String(), true
	}
	return "", false
}

// Every URL an attachment carries has to be signed on its way out. The file endpoint is signature
// gated, so an unsigned one is a 401 on every cross-origin client — which is exactly how thumbnails
// shipped broken while looking fine on same-origin web.
func TestMessageEgress_SignsEveryAttachmentURL(t *testing.T) {
	fields := urlFields(models.Attachment{})
	if len(fields) < 2 {
		t.Fatalf("expected the attachment to carry several URL fields, found %v", fields)
	}

	thumb := "/api/files/messages/ch1/thumb.webp"
	svc := NewMessageService(
		&testutil.MockMessageRepo{
			GetByChannelIDFn: func(_ context.Context, _ string, _ string, _ int) ([]models.Message, error) {
				return []models.Message{{ID: "m1", ChannelID: "ch1", UserID: "u1"}}, nil
			},
		},
		&testutil.MockAttachmentRepo{
			GetByMessageIDsFn: func(_ context.Context, _ []string) ([]models.Attachment, error) {
				return []models.Attachment{{
					ID: "a1", MessageID: "m1",
					FileURL:  "/api/files/messages/ch1/photo.jpg",
					ThumbURL: &thumb,
				}}, nil
			},
		},
		&testutil.MockChannelRepo{}, &testutil.MockUserRepo{},
		&testutil.MockMentionRepo{}, &testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{}, &testutil.MockReactionRepo{}, &testutil.MockReadStateRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermReadMessages, nil
			},
		},
		markingSigner{}, &testutil.MockFileDeleter{}, &testutil.MockStorageService{},
		stubServerEncryption{},
	)

	page, err := svc.GetByChannelID(context.Background(), "ch1", "u1", "", 50)
	if err != nil {
		t.Fatalf("GetByChannelID: %v", err)
	}
	att := page.Messages[0].Attachments[0]

	for _, name := range fields {
		value, set := fieldString(att, name)
		if !set {
			t.Errorf("%s was not populated by the test, so its signing is unproven — extend the fixture", name)
			continue
		}
		if !strings.HasSuffix(value, "?sig") {
			t.Errorf("%s is served unsigned (%q); the file endpoint answers 401 for it cross-origin", name, value)
		}
	}
}

// The DM attachment is a separate model behind separate queries and a separate signing site. If it
// gains or loses a URL field independently, one of the two paths is about to be forgotten — which is
// what happened when thumb_url was signed for channels and not for DMs.
func TestAttachmentModels_CarryTheSameURLFields(t *testing.T) {
	channel := urlFields(models.Attachment{})
	dm := urlFields(models.DMAttachment{})

	if !reflect.DeepEqual(channel, dm) {
		t.Errorf(
			"attachment URL fields have diverged:\n  channel: %v\n  DM:      %v\n"+
				"both are signed at egress and both feed the same components — keep them in step",
			channel, dm,
		)
	}
}
