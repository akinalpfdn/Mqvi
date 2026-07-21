package services

import "github.com/akinalp/mqvi/models"

// FileURLSigner signs file URLs before they reach the client.
// ISP interface — services depend on this, not the concrete Signer.
type FileURLSigner interface {
	// SignURL signs a file URL if it matches the file prefix.
	// Legacy /api/uploads/ URLs pass through unchanged.
	SignURL(fileURL string) string
	// SignURLPtr is like SignURL but for *string fields (avatar_url, icon_url, etc.).
	SignURLPtr(fileURL *string) *string
}

// SignAttachmentURLs signs every file URL an attachment carries on its way to the client.
//
// The file endpoint is signature gated, so an unsigned URL is a 401 on every cross-origin client.
// Five call sites used to spell this out field by field — two in the message service, one in the DM
// service and one in each upload handler — and thumb_url shipped signed at some of them and not
// others. Adding the next URL field is now one edit here, and one test holds it.
func SignAttachmentURLs(signer FileURLSigner, a *models.Attachment) {
	a.FileURL = signer.SignURL(a.FileURL)
	a.ThumbURL = signer.SignURLPtr(a.ThumbURL)
}

// SignDMAttachmentURLs is SignAttachmentURLs for the DM model, which is a separate type behind
// separate queries. The two must stay in step; a test asserts they declare the same URL fields.
func SignDMAttachmentURLs(signer FileURLSigner, a *models.DMAttachment) {
	a.FileURL = signer.SignURL(a.FileURL)
	a.ThumbURL = signer.SignURLPtr(a.ThumbURL)
}

// FileDeleter removes a file from disk given its stored URL.
// ISP interface wrapping files.Locator delete methods.
type FileDeleter interface {
	// DeleteFromURL is fire-and-forget. Errors (including missing files) are swallowed.
	// Use this from request paths where a failed delete is acceptable.
	DeleteFromURL(storedURL string)
	// DeleteFromURLChecked returns the underlying os.Remove error so callers can
	// queue retries. Missing files (os.IsNotExist) and empty/legacy URLs return nil.
	DeleteFromURLChecked(storedURL string) error
}
