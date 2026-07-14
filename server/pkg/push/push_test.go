package push

import "testing"

// The DM notification is the highest-volume message we send. Without a collapse key these are
// NON-collapsible, and FCM stores at most 100 of those for an offline device before discarding
// ALL of them — including the incoming-call push queued behind them.
func TestAndroidConfig_MessagesCollapsePerConversation(t *testing.T) {
	cfg := androidConfig(CategoryMessage, "dm:chan-1")

	if cfg.CollapseKey != "dm:chan-1" {
		t.Errorf("collapse key %q, want dm:chan-1 — without it a chatty DM burst can flush the queued call push",
			cfg.CollapseKey)
	}
	if cfg.Priority != "high" {
		t.Errorf("priority %q, want high — a message notification is user-visible", cfg.Priority)
	}
	if cfg.Notification.ChannelID != "messages" {
		t.Errorf("channel %q, want messages", cfg.Notification.ChannelID)
	}
}

// Two incoming calls are two events. Collapsing them would let the second replace the first.
func TestAndroidConfig_CallsAreNeverCollapsed(t *testing.T) {
	cfg := androidConfig(CategoryCall, "call:1")

	if cfg.CollapseKey != "" {
		t.Errorf("calls got collapse key %q — a second call would replace the first", cfg.CollapseKey)
	}
	if cfg.Priority != "high" {
		t.Errorf("priority %q, want high — a call has to wake a dozing phone", cfg.Priority)
	}
	if cfg.Notification.ChannelID != "calls" {
		t.Errorf("channel %q, want calls", cfg.Notification.ChannelID)
	}
}
