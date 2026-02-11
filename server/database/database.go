// Package database, SQLite bağlantısını ve migration sistemini yönetir.
//
// Go'da database/sql standart kütüphanesi, farklı veritabanlarına ortak bir
// arayüz (interface) sağlar. SQLite driver (go-sqlite3) import edildiğinde
// otomatik olarak kayıt olur — "blank import" (_ "github.com/mattn/go-sqlite3")
// bu yüzden kullanılır: import'un yan etkisi (side effect) gereklidir.
package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite" // Pure-Go SQLite driver — CGO gerekmez, her platformda çalışır
)

// DB, veritabanı bağlantısını saran struct.
// *sql.DB Go'nun built-in connection pool'udur — thread-safe'dir,
// birden fazla goroutine aynı anda güvenle kullanabilir.
type DB struct {
	Conn *sql.DB
}

// New, yeni bir SQLite bağlantısı oluşturur ve migration'ları çalıştırır.
//
// dbPath: SQLite dosya yolu (ör: "./data/mqvi.db")
// migrationsDir: SQL migration dosyalarının bulunduğu dizin
//
// Fonksiyon imzasındaki (*DB, error) Go'nun "multiple return value" özelliğidir.
// Başarılı olursa (*DB, nil), başarısızsa (nil, error) döner.
func New(dbPath string, migrationsDir string) (*DB, error) {
	// Veritabanı dosyasının bulunduğu dizini oluştur (yoksa)
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	// SQLite bağlantısı aç
	// "_foreign_keys=on" → Foreign key constraint'leri aktif et (SQLite'ta varsayılan kapalı!)
	// "_journal_mode=WAL" → Write-Ahead Logging: eşzamanlı okuma/yazma performansı
	// modernc.org/sqlite driver adı "sqlite" (mattn'ınki "sqlite3" idi)
	// Pragma'lar query param yerine bağlantı sonrası PRAGMA ile de ayarlanabilir.
	conn, err := sql.Open("sqlite", dbPath+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Bağlantıyı test et
	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	db := &DB{Conn: conn}

	// Migration'ları çalıştır
	if err := db.runMigrations(migrationsDir); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	log.Println("[database] connected and migrations applied")
	return db, nil
}

// Close, veritabanı bağlantısını kapatır.
// Go'da resource cleanup "defer" ile yapılır:
//
//	db, _ := database.New(...)
//	defer db.Close()  // fonksiyon bittiğinde otomatik çağrılır
func (db *DB) Close() error {
	return db.Conn.Close()
}

// runMigrations, migrations/ dizinindeki SQL dosyalarını sırayla çalıştırır.
// Dosya isimleri sıralıdır: 001_init.sql, 002_seed.sql, ...
// Her migration IF NOT EXISTS kullandığı için tekrar çalıştırmak güvenlidir (idempotent).
func (db *DB) runMigrations(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("failed to read migrations directory: %w", err)
	}

	// Sadece .sql dosyalarını al
	var sqlFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			sqlFiles = append(sqlFiles, entry.Name())
		}
	}

	// Alfabetik sırala (001_, 002_, ...)
	sort.Strings(sqlFiles)

	for _, file := range sqlFiles {
		path := filepath.Join(dir, file)

		content, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("failed to read migration %s: %w", file, err)
		}

		if _, err := db.Conn.Exec(string(content)); err != nil {
			return fmt.Errorf("failed to execute migration %s: %w", file, err)
		}

		log.Printf("[database] migration applied: %s", file)
	}

	return nil
}
