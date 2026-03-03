// Package models — Report domain modeli.
//
// Report, bir kullanıcının başka bir kullanıcıyı raporlamasını temsil eder.
// Predefined reason kategorileri + zorunlu açıklama ile oluşturulur.
// Admin panelinden raporlar yönetilir: pending → reviewed → resolved/dismissed.
package models

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// ReportReason, rapor nedeni typed constant.
type ReportReason string

const (
	ReportReasonSpam            ReportReason = "spam"
	ReportReasonHarassment      ReportReason = "harassment"
	ReportReasonInappropriate   ReportReason = "inappropriate_content"
	ReportReasonImpersonation   ReportReason = "impersonation"
	ReportReasonOther           ReportReason = "other"
)

// validReportReasons, kabul edilen rapor nedenleri.
var validReportReasons = map[ReportReason]bool{
	ReportReasonSpam:          true,
	ReportReasonHarassment:    true,
	ReportReasonInappropriate: true,
	ReportReasonImpersonation: true,
	ReportReasonOther:         true,
}

// ReportStatus, rapor durumu typed constant.
type ReportStatus string

const (
	ReportStatusPending   ReportStatus = "pending"
	ReportStatusReviewed  ReportStatus = "reviewed"
	ReportStatusResolved  ReportStatus = "resolved"
	ReportStatusDismissed ReportStatus = "dismissed"
)

// Report, bir kullanıcı raporunu temsil eder.
// Time field'ları string: SQLite TEXT olarak saklar, modernc.org/sqlite time.Time'a otomatik dönüştürmez.
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

// ReportAttachment, rapor delili olarak eklenen dosya (sadece resimler).
// Mevcut Attachment / DMAttachment ile paralel yapı.
type ReportAttachment struct {
	ID        string  `json:"id"`
	ReportID  string  `json:"report_id"`
	Filename  string  `json:"filename"`
	FileURL   string  `json:"file_url"`
	FileSize  *int64  `json:"file_size"`
	MimeType  *string `json:"mime_type"`
	CreatedAt string  `json:"created_at"`
}

// ReportWithUsers, rapor + raporlayan ve raporlanan kullanıcı bilgisi.
// Admin panelinde kullanılır.
type ReportWithUsers struct {
	Report
	ReporterUsername string  `json:"reporter_username"`
	ReporterDisplay  *string `json:"reporter_display_name"`
	ReportedUsername string  `json:"reported_username"`
	ReportedDisplay  *string `json:"reported_display_name"`
}

// validReportStatuses, kabul edilen rapor durumları.
// Admin panelinde status değiştirirken validation için kullanılır.
var validReportStatuses = map[ReportStatus]bool{
	ReportStatusPending:   true,
	ReportStatusReviewed:  true,
	ReportStatusResolved:  true,
	ReportStatusDismissed: true,
}

// UpdateReportStatusRequest, admin panelden rapor durumu güncelleme isteği.
type UpdateReportStatusRequest struct {
	Status string `json:"status"`
}

// Validate, UpdateReportStatusRequest kontrolü.
// Status predefined setlerden biri olmalı (pending, reviewed, resolved, dismissed).
func (r *UpdateReportStatusRequest) Validate() error {
	status := ReportStatus(r.Status)
	if !validReportStatuses[status] {
		return fmt.Errorf("invalid report status: %s", r.Status)
	}
	return nil
}

// CreateReportRequest, rapor oluşturma isteği.
type CreateReportRequest struct {
	Reason      string `json:"reason"`
	Description string `json:"description"`
}

// Validate, CreateReportRequest kontrolü.
// Reason predefined setlerden biri olmalı, description 10-1000 karakter.
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
