// Package database embed dosyası — migration SQL dosyalarını binary'ye gömer.
//
// Go'nun embed paketi, derleme zamanında dosyaları binary'nin içine gömer.
// Bu sayede deploy edilen binary yanında migration dosyalarına ihtiyaç duymaz.
// //go:embed directive'i derleyiciye hangi dosyaları gömeceğini söyler.
package database

import "embed"

// EmbeddedMigrations, migrations/ dizinindeki SQL dosyalarını içerir.
// Kullanım: fs.Sub(EmbeddedMigrations, "migrations") ile alt dizine eriş.
//
//go:embed migrations/*.sql
var EmbeddedMigrations embed.FS
