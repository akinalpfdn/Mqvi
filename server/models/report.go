// Package models — Report domain modeli.
//
// Report, bir kullanıcının başka bir kullanıcıyı raporlamasını temsil eder.
// Predefined reason kategorileri + zorunlu açıklama ile oluşturulur.
// Admin panelinden raporlar yönetilir: pending → reviewed → resolved/dismissed.
package models

import (
	"fmt"
	"strings"
	"time"
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
type Report struct {
	ID             string       `json:"id"`
	ReporterID     string       `json:"reporter_id"`
	ReportedUserID string       `json:"reported_user_id"`
	Reason         ReportReason `json:"reason"`
	Description    string       `json:"description"`
	Status         ReportStatus `json:"status"`
	ResolvedBy     *string      `json:"resolved_by"`
	ResolvedAt     *time.Time   `json:"resolved_at"`
	CreatedAt      time.Time    `json:"created_at"`
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
