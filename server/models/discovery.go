package models

// PublicServerListItem is a discovery directory card. It exposes only public preview data —
// never members, channels, or private settings. OnlineCount is filled from the WS hub, not SQL.
type PublicServerListItem struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	IconURL          *string `json:"icon_url"`
	BannerURL        *string `json:"banner_url"`
	Description      *string `json:"description"`
	Category         *string `json:"category"`
	MemberCount      int     `json:"member_count"`
	OnlineCount      int     `json:"online_count"`
	Verified         bool    `json:"verified"`
	Featured         bool    `json:"featured"`
	ApprovalRequired bool    `json:"approval_required"`
	IsMember         bool    `json:"is_member"`
}

// PublicServerListParams filters and paginates the discovery list.
type PublicServerListParams struct {
	RequestingUserID string // for the is_member flag
	Category         string // empty = all categories
	Search           string // empty = no text filter
	FeaturedOnly     bool
	Limit            int
	Offset           int
}

// PublicServerListPage is a page of discovery results.
type PublicServerListPage struct {
	Items []PublicServerListItem `json:"items"`
	Total int                    `json:"total"`
}
