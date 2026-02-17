// Package i18n embed dosyası — çeviri JSON dosyalarını binary'ye gömer.
//
// Backend çeviri dosyaları (en.json, tr.json) derleme zamanında
// binary'ye gömülür. Deploy edilen sunucu harici dosyalara ihtiyaç duymaz.
package i18n

import "embed"

// EmbeddedLocales, locales/ dizinindeki JSON dosyalarını içerir.
// Kullanım: fs.Sub(EmbeddedLocales, "locales") ile alt dizine eriş.
//
//go:embed locales/*.json
var EmbeddedLocales embed.FS
