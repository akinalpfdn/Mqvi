package models

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

type ReportReason string

const (
	ReportReasonSpam          ReportReason = "spam"
	ReportReasonHarassment    ReportReason = "harassment"
	ReportReasonInappropriate ReportReason = "inappropriate_content"
	ReportReasonImpersonation ReportReason = "impersonation"
	ReportReasonOther         ReportReason = "other"
)

var validReportReasons = map[ReportReason]bool{
	ReportReasonSpam:          true,
	ReportReasonHarassment:    true,
	ReportReasonInappropriate: true,
	ReportReasonImpersonation: true,
	ReportReasonOther:         true,
}

type ReportStatus string

const (
	ReportStatusPending   ReportStatus = "pending"
	ReportStatusReviewed  ReportStatus = "reviewed"
	ReportStatusResolved  ReportStatus = "resolved"
	ReportStatusDismissed ReportStatus = "dismissed"
)

// Report — time fields are strings because modernc.org/sqlite doesn't auto-convert to time.Time.
type Report struct {
	ID             string             `json:"id"`
	ReporterID     string             `json:"reporter_id"`
	ReportedUserID string             `json:"reported_user_id"`
	Reason         ReportReason       `json:"reason"`
	Description    string             `json:"description"`
	Status         ReportStatus       `json:"status"`
	ResolvedBy     *string            `json:"resolved_by"`
	ResolvedAt     *string            `json:"resolved_at"`
	CreatedAt      string             `json:"created_at"`
	Attachments    []ReportAttachment `json:"attachments"`
}

// ReportAttachment — evidence file (images only). Parallel structure to Attachment/DMAttachment.
type ReportAttachment struct {
	ID        string  `json:"id"`
	ReportID  string  `json:"report_id"`
	Filename  string  `json:"filename"`
	FileURL   string  `json:"file_url"`
	FileSize  *int64  `json:"file_size"`
	MimeType  *string `json:"mime_type"`
	CreatedAt string  `json:"created_at"`
}

// ReportWithUsers — report with reporter and reported user info for admin panel.
type ReportWithUsers struct {
	Report
	ReporterUsername string  `json:"reporter_username"`
	ReporterDisplay  *string `json:"reporter_display_name"`
	ReportedUsername string  `json:"reported_username"`
	ReportedDisplay  *string `json:"reported_display_name"`
}

var validReportStatuses = map[ReportStatus]bool{
	ReportStatusPending:   true,
	ReportStatusReviewed:  true,
	ReportStatusResolved:  true,
	ReportStatusDismissed: true,
}

type UpdateReportStatusRequest struct {
	Status string `json:"status"`
}

func (r *UpdateReportStatusRequest) Validate() error {
	status := ReportStatus(r.Status)
	if !validReportStatuses[status] {
		return fmt.Errorf("invalid report status: %s", r.Status)
	}
	return nil
}

type CreateReportRequest struct {
	Reason      string `json:"reason"`
	Description string `json:"description"`
}

func (r *CreateReportRequest) Validate() error {
	r.Description = strings.TrimSpace(r.Description)

	reason := ReportReason(r.Reason)
	if !validReportReasons[reason] {
		return fmt.Errorf("invalid report reason: %s", r.Reason)
	}

	descLen := utf8.RuneCountInString(r.Description)
	if descLen < 10 {
		return fmt.Errorf("description must be at least 10 characters")
	}
	if descLen > 1000 {
		return fmt.Errorf("description must be at most 1000 characters")
	}

	return nil
}
