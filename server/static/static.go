package static

import "embed"

// FrontendFS embeds the React build output from dist/.
// "all:" includes dotfiles like .gitkeep.
//
//go:embed all:dist
var FrontendFS embed.FS
