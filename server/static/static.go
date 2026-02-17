// Package static, React frontend build çıktısını binary'ye gömer.
//
// Build sırasında client/dist/ içeriği server/static/dist/ dizinine kopyalanır,
// ardından Go derleyicisi bu dosyaları binary'ye gömer.
//
// Development modunda dist/ içi boş olabilir (.gitkeep) —
// bu durumda Vite dev server frontend'i servis eder.
//
// Production'da binary frontend'i doğrudan servis eder (SPA fallback ile).
package static

import "embed"

// FrontendFS, dist/ dizinindeki frontend build dosyalarını içerir.
// "all:" prefix'i .gitkeep gibi nokta ile başlayan dosyaları da dahil eder.
// Kullanım: fs.Sub(FrontendFS, "dist") ile alt dizine eriş.
//
//go:embed all:dist
var FrontendFS embed.FS
