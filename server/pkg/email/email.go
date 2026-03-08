// Package email provides an abstraction layer for sending emails.
// Currently uses Resend API. Swap the implementation to switch providers.
package email

import (
	"context"
	"fmt"

	"github.com/resend/resend-go/v3"
)

type EmailSender interface {
	SendPasswordReset(ctx context.Context, toEmail, token string) error
	SendPlatformBanNotification(ctx context.Context, toEmail, reason string) error
	SendAccountDeleteNotification(ctx context.Context, toEmail, reason string) error
	SendServerDeleteNotification(ctx context.Context, toEmail, serverName, reason string) error
}

type resendSender struct {
	client    *resend.Client
	fromEmail string
	appURL    string
}

func NewResendSender(apiKey, fromEmail, appURL string) EmailSender {
	return &resendSender{
		client:    resend.NewClient(apiKey),
		fromEmail: fromEmail,
		appURL:    appURL,
	}
}

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

func (s *resendSender) SendPlatformBanNotification(ctx context.Context, toEmail, reason string) error {
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
              <h2 style="color:#e2e8f0;font-size:18px;margin:0 0 24px 0;">Account Suspended</h2>
              <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 24px 0;">
                Your mqvi account has been suspended by a platform administrator.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;width:100%%;">
                <tr>
                  <td style="background-color:#1e293b;border-radius:6px;padding:16px;border-left:4px solid #ef4444;">
                    <p style="color:#64748b;font-size:13px;margin:0 0 4px 0;font-weight:600;">Reason</p>
                    <p style="color:#e2e8f0;font-size:15px;line-height:1.6;margin:0;">%s</p>
                  </td>
                </tr>
              </table>
              <p style="color:#64748b;font-size:13px;line-height:1.6;margin:0;">
                If you believe this was a mistake, please contact the platform administrator.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`, reason)

	params := &resend.SendEmailRequest{
		From:    fmt.Sprintf("mqvi <%s>", s.fromEmail),
		To:      []string{toEmail},
		Subject: "Your Account Has Been Suspended — mqvi",
		Html:    html,
	}

	_, err := s.client.Emails.SendWithContext(ctx, params)
	if err != nil {
		return fmt.Errorf("failed to send platform ban notification: %w", err)
	}

	return nil
}

// SendAccountDeleteNotification must be called BEFORE the user is deleted
// (otherwise we lose the email address).
func (s *resendSender) SendAccountDeleteNotification(ctx context.Context, toEmail, reason string) error {
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
              <h2 style="color:#e2e8f0;font-size:18px;margin:0 0 24px 0;">Account Deleted</h2>
              <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 24px 0;">
                Your mqvi account has been permanently deleted by a platform administrator.
                All associated data has been removed.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;width:100%%;">
                <tr>
                  <td style="background-color:#1e293b;border-radius:6px;padding:16px;border-left:4px solid #ef4444;">
                    <p style="color:#64748b;font-size:13px;margin:0 0 4px 0;font-weight:600;">Reason</p>
                    <p style="color:#e2e8f0;font-size:15px;line-height:1.6;margin:0;">%s</p>
                  </td>
                </tr>
              </table>
              <p style="color:#64748b;font-size:13px;line-height:1.6;margin:0;">
                If you believe this was a mistake, please contact the platform administrator.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`, reason)

	params := &resend.SendEmailRequest{
		From:    fmt.Sprintf("mqvi <%s>", s.fromEmail),
		To:      []string{toEmail},
		Subject: "Your Account Has Been Deleted — mqvi",
		Html:    html,
	}

	_, err := s.client.Emails.SendWithContext(ctx, params)
	if err != nil {
		return fmt.Errorf("failed to send account delete notification: %w", err)
	}

	return nil
}

func (s *resendSender) SendServerDeleteNotification(ctx context.Context, toEmail, serverName, reason string) error {
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
              <h2 style="color:#e2e8f0;font-size:18px;margin:0 0 24px 0;">Server Deleted</h2>
              <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 24px 0;">
                Your server <strong style="color:#e2e8f0;">%s</strong> has been deleted by a platform administrator.
                All channels, messages, and members have been removed.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;width:100%%;">
                <tr>
                  <td style="background-color:#1e293b;border-radius:6px;padding:16px;border-left:4px solid #ef4444;">
                    <p style="color:#64748b;font-size:13px;margin:0 0 4px 0;font-weight:600;">Reason</p>
                    <p style="color:#e2e8f0;font-size:15px;line-height:1.6;margin:0;">%s</p>
                  </td>
                </tr>
              </table>
              <p style="color:#64748b;font-size:13px;line-height:1.6;margin:0;">
                If you believe this was a mistake, please contact the platform administrator.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`, serverName, reason)

	params := &resend.SendEmailRequest{
		From:    fmt.Sprintf("mqvi <%s>", s.fromEmail),
		To:      []string{toEmail},
		Subject: "Your Server Has Been Deleted — mqvi",
		Html:    html,
	}

	_, err := s.client.Emails.SendWithContext(ctx, params)
	if err != nil {
		return fmt.Errorf("failed to send server delete notification: %w", err)
	}

	return nil
}
