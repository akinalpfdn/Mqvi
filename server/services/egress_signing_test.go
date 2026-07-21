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
// things to sign lived at five call sites and nobody's head.
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

// populateURLFields fills every URL field with a probe value, so the signer has something to sign
// and an unsigned field is visible afterwards. A test that populated them by hand would only ever
// cover the fields whoever wrote it remembered.
func populateURLFields(v any, value string) {
	rv := reflect.ValueOf(v).Elem()
	for _, name := range urlFields(v) {
		f := rv.FieldByName(name)
		switch f.Kind() {
		case reflect.String:
			f.SetString(value)
		case reflect.Ptr:
			p := reflect.New(f.Type().Elem())
			p.Elem().SetString(value)
			f.Set(p)
		}
	}
}

// assertEveryURLSigned checks the model carries no URL the file endpoint would reject.
func assertEveryURLSigned(t *testing.T, v any) {
	t.Helper()
	rv := reflect.ValueOf(v).Elem()
	for _, name := range urlFields(v) {
		f := rv.FieldByName(name)
		var got string
		switch f.Kind() {
		case reflect.String:
			got = f.String()
		case reflect.Ptr:
			if f.IsNil() {
				t.Errorf("%s came back nil — the signer dropped it", name)
				continue
			}
			got = f.Elem().String()
		}
		if !strings.HasSuffix(got, "?sig") {
			t.Errorf(
				"%s is served unsigned (%q); the file endpoint answers 401 for it cross-origin",
				name, got,
			)
		}
	}
}

// Every URL an attachment carries has to be signed on its way out, and this is the one function
// that does it for all five egress paths. A field added to the model and forgotten here is a 401
// on every cross-origin client — which is exactly how thumbnails shipped broken while looking fine
// on same-origin web.
func TestSignAttachmentURLs_SignsEveryURLTheModelDeclares(t *testing.T) {
	fields := urlFields(models.Attachment{})
	if len(fields) < 2 {
		t.Fatalf("expected the attachment to carry several URL fields, found %v", fields)
	}

	att := &models.Attachment{}
	populateURLFields(att, "/api/files/messages/ch1/photo.jpg")

	SignAttachmentURLs(markingSigner{}, att)

	assertEveryURLSigned(t, att)
}

func TestSignDMAttachmentURLs_SignsEveryURLTheModelDeclares(t *testing.T) {
	att := &models.DMAttachment{}
	populateURLFields(att, "/api/files/dms/c1/photo.jpg")

	SignDMAttachmentURLs(markingSigner{}, att)

	assertEveryURLSigned(t, att)
}

// The DM attachment is a separate model behind separate queries and a separate signing helper. If
// it gains or loses a URL field independently, one of the two paths is about to be forgotten —
// which is what happened when thumb_url was signed for channels and not for DMs.
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

// Guarding the helper only proves the helper. This drives the read path end to end, so a call site
// that stops routing through it fails here rather than shipping unsigned URLs to every client.
func TestMessageEgress_RoutesAttachmentsThroughTheSigner(t *testing.T) {
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
	assertEveryURLSigned(t, &att)
}
