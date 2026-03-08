package i18n

import "embed"

//go:embed locales/*.json
var EmbeddedLocales embed.FS
