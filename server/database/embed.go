package database

import "embed"

//go:embed migrations/*.sql
var EmbeddedMigrations embed.FS
