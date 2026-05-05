package services

// FileURLSigner signs file URLs before they reach the client.
// ISP interface — services depend on this, not the concrete Signer.
type FileURLSigner interface {
	// SignURL signs a file URL if it matches the file prefix.
	// Legacy /api/uploads/ URLs pass through unchanged.
	SignURL(fileURL string) string
	// SignURLPtr is like SignURL but for *string fields (avatar_url, icon_url, etc.).
	SignURLPtr(fileURL *string) *string
}
