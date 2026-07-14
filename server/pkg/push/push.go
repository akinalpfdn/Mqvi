// Package push delivers mobile push notifications via Firebase Cloud Messaging.
package push

import (
	"context"
	"fmt"
	"os"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/messaging"
	"google.golang.org/api/option"
)

// Notification categories map to platform-specific delivery (Android channel, sound).
const (
	CategoryMessage = "message"
	CategoryCall    = "call"
)

// Notification is a platform-agnostic push payload.
type Notification struct {
	Title    string
	Body     string
	Category string            // CategoryMessage | CategoryCall
	Data     map[string]string // deep-link payload delivered to the client on tap
	// Tag groups a conversation's notifications on Android. A backgrounded app never sees
	// these in onMessageReceived — the FCM SDK posts them itself — so the tag is the only
	// handle native code has to find and cancel them once the chat is read elsewhere.
	// It also collapses a conversation to one notification instead of a stack.
	Tag string
}

// DataMessage is a data-only push: no notification payload, so it reaches the app's
// FirebaseMessagingService even when the app is killed and the native side decides what to show.
type DataMessage struct {
	Data map[string]string
	// CollapseKey lets FCM replace an undelivered message of the same key rather than queue
	// another one. It matters more than it looks: FCM stores at most 100 pending NON-collapsible
	// messages for an offline device and discards ALL of them on overflow — so a chatty session
	// can destroy the incoming-call push queued for a phone that is off-network. Empty means
	// non-collapsible, which is right when every message is a distinct event (an incoming call).
	CollapseKey string
	// HighPriority wakes a dozing device. Reserve it for things the user must see now: Google
	// downranks senders whose high-priority messages produce no user-visible notification, and
	// that downranking would land on calls.
	HighPriority bool
}

// Sender delivers push notifications to device tokens.
type Sender interface {
	// Send delivers n to every token. Returns the subset of tokens FCM reports as
	// permanently unregistered so the caller can prune them. A nil error with a
	// non-empty invalid slice is normal (partial success).
	Send(ctx context.Context, tokens []string, n Notification) (invalid []string, err error)
	// SendData delivers a data-only message. Returns unregistered tokens to prune.
	SendData(ctx context.Context, tokens []string, m DataMessage) (invalid []string, err error)
	// Enabled reports whether a real FCM client is configured.
	Enabled() bool
}

type fcmSender struct {
	client *messaging.Client // nil => disabled
}

// NewSender builds an FCM sender from a service-account credentials file. A missing
// file or init failure yields a disabled (no-op) sender rather than an error — push
// is optional and the server must still start.
func NewSender(ctx context.Context, credentialsFile string) (Sender, error) {
	if credentialsFile == "" {
		return &fcmSender{}, nil
	}
	if _, err := os.Stat(credentialsFile); err != nil {
		// No credentials file -> push disabled. Normal for self-hosted instances
		// without FCM configured; not an error.
		return &fcmSender{}, nil
	}
	app, err := firebase.NewApp(ctx, nil, option.WithCredentialsFile(credentialsFile))
	if err != nil {
		return &fcmSender{}, fmt.Errorf("init firebase app: %w", err)
	}
	client, err := app.Messaging(ctx)
	if err != nil {
		return &fcmSender{}, fmt.Errorf("init fcm client: %w", err)
	}
	return &fcmSender{client: client}, nil
}

func (s *fcmSender) Enabled() bool { return s.client != nil }

func (s *fcmSender) Send(ctx context.Context, tokens []string, n Notification) ([]string, error) {
	if s.client == nil || len(tokens) == 0 {
		return nil, nil
	}

	msg := &messaging.MulticastMessage{
		Tokens:       tokens,
		Notification: &messaging.Notification{Title: n.Title, Body: n.Body},
		Data:         n.Data,
		Android:      androidConfig(n.Category, n.Tag),
		APNS:         apnsConfig(),
	}

	resp, err := s.client.SendEachForMulticast(ctx, msg)
	if err != nil {
		return nil, fmt.Errorf("fcm multicast send: %w", err)
	}

	var invalid []string
	for i, r := range resp.Responses {
		// Prune only on UNREGISTERED — a token FCM confirms is permanently dead.
		// Other failures (transient, malformed payload) must not delete live tokens.
		if !r.Success && messaging.IsUnregistered(r.Error) {
			invalid = append(invalid, tokens[i])
		}
	}
	return invalid, nil
}

func (s *fcmSender) SendData(ctx context.Context, tokens []string, m DataMessage) ([]string, error) {
	if s.client == nil || len(tokens) == 0 {
		return nil, nil
	}

	priority := "normal"
	if m.HighPriority {
		priority = "high"
	}
	msg := &messaging.MulticastMessage{
		Tokens: tokens,
		Data:   m.Data,
		// No Notification payload on purpose: that is what routes the message to
		// onMessageReceived (native FMS) instead of being posted by the FCM SDK itself.
		Android: &messaging.AndroidConfig{
			Priority:    priority,
			CollapseKey: m.CollapseKey,
		},
	}

	resp, err := s.client.SendEachForMulticast(ctx, msg)
	if err != nil {
		return nil, fmt.Errorf("fcm data multicast send: %w", err)
	}

	var invalid []string
	for i, r := range resp.Responses {
		if !r.Success && messaging.IsUnregistered(r.Error) {
			invalid = append(invalid, tokens[i])
		}
	}
	return invalid, nil
}

func androidConfig(category, tag string) *messaging.AndroidConfig {
	channelID := "messages"
	if category == CategoryCall {
		channelID = "calls"
	}
	return &messaging.AndroidConfig{
		Priority: "high",
		Notification: &messaging.AndroidNotification{
			ChannelID: channelID,
			Sound:     "default",
			Tag:       tag,
		},
	}
}

func apnsConfig() *messaging.APNSConfig {
	return &messaging.APNSConfig{
		Payload: &messaging.APNSPayload{
			Aps: &messaging.Aps{Sound: "default"},
		},
	}
}
