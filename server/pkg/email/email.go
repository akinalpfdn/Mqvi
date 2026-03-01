// Package email, uygulama genelinde email gönderimi için soyutlama katmanı sağlar.
//
// EmailSender interface'i ile email gönderim detayları soyutlanır (Dependency Inversion).
// Şu anki implementasyon Resend API kullanır. İleride farklı bir sağlayıcıya
// geçmek için sadece yeni bir implementasyon yazıp constructor'da değiştirmek yeterli.
//
// Bu paket dışarıya iki şey sunar:
// 1. EmailSender interface — service'ler buna bağımlı olur
// 2. NewResendSender constructor — main.go'da wire-up için
package email

import (
	"context"
	"fmt"

	"github.com/resend/resend-go/v3"
)

// EmailSender, email gönderimi için interface.
// Service katmanı bu interface'e bağımlıdır, concrete Resend implementasyonuna değil.
type EmailSender interface {
	// SendPasswordReset, kullanıcıya şifre sıfırlama linki içeren email gönderir.
	// toEmail: alıcı email adresi, token: plaintext reset token (link'e gömülecek).
	SendPasswordReset(ctx context.Context, toEmail, token string) error
}

// resendSender, Resend API ile email gönderen EmailSender implementasyonu.
type resendSender struct {
	client    *resend.Client
	fromEmail string // Gönderici adresi (ör: noreply@mqvi.app)
	appURL    string // Uygulamanın public URL'i (ör: https://app.mqvi.app)
}

// NewResendSender, Resend API client'ı ile yeni bir EmailSender oluşturur.
//
// apiKey: Resend dashboard'dan alınan API key (re_xxxxxxxx formatında).
// fromEmail: Gönderici email adresi — Resend'de doğrulanmış domain altında olmalı.
// appURL: Uygulamanın public URL'i — reset link'lerde kullanılır.
func NewResendSender(apiKey, fromEmail, appURL string) EmailSender {
	return &resendSender{
		client:    resend.NewClient(apiKey),
		fromEmail: fromEmail,
		appURL:    appURL,
	}
}

// SendPasswordReset, şifre sıfırlama email'i gönderir.
//
// Email içeriği:
// - Subject: "Reset Your Password — mqvi"
// - Body: Reset linki içeren basit HTML
// - Link format: {appURL}/reset-password?token={token}
//
// Token email'de plaintext olarak bulunur (DB'de SHA256 hash saklanır).
// Kullanıcı bu link'e tıkladığında frontend token'ı URL'den okur
// ve POST /api/auth/reset-password endpoint'ine gönderir.
func (s *resendSender) SendPasswordReset(ctx context.Context, toEmail, token string) error {
	resetLink := fmt.Sprintf("%s/reset-password?token=%s", s.appURL, token)

	html := fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#1a1a2e;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%%" cellpadding="0" cellspacing="0" style="background-color:#1a1a2e;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color:#16213e;border-radius:8px;padding:40px;">
          <tr>
            <td>
              <h1 style="color:#e2e8f0;font-size:24px;margin:0 0 8px 0;">mqvi</h1>
              <h2 style="color:#e2e8f0;font-size:18px;margin:0 0 24px 0;">Password Reset Request</h2>
              <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 24px 0;">
                We received a request to reset your password. Click the button below to choose a new password.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="background-color:#6366f1;border-radius:6px;padding:12px 32px;">
                    <a href="%s" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="color:#64748b;font-size:13px;line-height:1.6;margin:0 0 16px 0;">
                This link will expire in 20 minutes. If you didn't request a password reset, you can safely ignore this email.
              </p>
              <p style="color:#475569;font-size:13px;line-height:1.6;margin:0;word-break:break-all;">
                If the button doesn't work, copy and paste this link:<br>
                <a href="%s" style="color:#6366f1;">%s</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`, resetLink, resetLink, resetLink)

	params := &resend.SendEmailRequest{
		From:    fmt.Sprintf("mqvi <%s>", s.fromEmail),
		To:      []string{toEmail},
		Subject: "Reset Your Password — mqvi",
		Html:    html,
	}

	_, err := s.client.Emails.SendWithContext(ctx, params)
	if err != nil {
		return fmt.Errorf("failed to send password reset email: %w", err)
	}

	return nil
}
