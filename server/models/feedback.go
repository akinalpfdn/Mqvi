package models

import "fmt"

// ─── Enums ───

type FeedbackType string

const (
	FeedbackTypeBug        FeedbackType = "bug"
	FeedbackTypeSuggestion FeedbackType = "suggestion"
	FeedbackTypeQuestion   FeedbackType = "question"
	FeedbackTypeOther      FeedbackType = "other"
)

type FeedbackStatus string

const (
	FeedbackStatusOpen       FeedbackStatus = "open"
	FeedbackStatusInProgress FeedbackStatus = "in_progress"
	FeedbackStatusResolved   FeedbackStatus = "resolved"
	FeedbackStatusClosed     FeedbackStatus = "closed"
)

// ─── Entities ───

type FeedbackTicket struct {
	ID        string         `json:"id"`
	UserID    string         `json:"user_id"`
	Type      FeedbackType   `json:"type"`
	Subject   string         `json:"subject"`
	Content   string         `json:"content"`
	Status    FeedbackStatus `json:"status"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}

type FeedbackTicketWithUser struct {
	FeedbackTicket
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name,omitempty"`
	ReplyCount  int     `json:"reply_count"`
}

type FeedbackReply struct {
	ID        string `json:"id"`
	TicketID  string `json:"ticket_id"`
	UserID    string `json:"user_id"`
	IsAdmin   bool   `json:"is_admin"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

type FeedbackReplyWithUser struct {
	FeedbackReply
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name,omitempty"`
}

// ─── Requests ───

type CreateFeedbackRequest struct {
	Type    string `json:"type"`
	Subject string `json:"subject"`
	Content string `json:"content"`
}

func (r *CreateFeedbackRequest) Validate() error {
	switch FeedbackType(r.Type) {
	case FeedbackTypeBug, FeedbackTypeSuggestion, FeedbackTypeQuestion, FeedbackTypeOther:
	default:
		return fmt.Errorf("invalid feedback type: %s", r.Type)
	}
	if len(r.Subject) < 3 || len(r.Subject) > 200 {
		return fmt.Errorf("subject must be 3-200 characters")
	}
	if len(r.Content) < 10 || len(r.Content) > 5000 {
		return fmt.Errorf("content must be 10-5000 characters")
	}
	return nil
}

type CreateFeedbackReplyRequest struct {
	Content string `json:"content"`
}

func (r *CreateFeedbackReplyRequest) Validate() error {
	if len(r.Content) < 1 || len(r.Content) > 5000 {
		return fmt.Errorf("reply content must be 1-5000 characters")
	}
	return nil
}

type UpdateFeedbackStatusRequest struct {
	Status string `json:"status"`
}

func (r *UpdateFeedbackStatusRequest) Validate() error {
	switch FeedbackStatus(r.Status) {
	case FeedbackStatusOpen, FeedbackStatusInProgress, FeedbackStatusResolved, FeedbackStatusClosed:
	default:
		return fmt.Errorf("invalid feedback status: %s", r.Status)
	}
	return nil
}
