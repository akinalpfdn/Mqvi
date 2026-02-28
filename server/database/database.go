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
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite" // Pure-Go SQLite driver — CGO gerekmez, her platformda çalışır
)

// recoverableError, migration sırasında tolere edilebilen hata pattern'larıdır.
// Örneğin yarım kalan bir migration tekrar çalıştırıldığında "duplicate column name"
// hatası verir — bu güvenle atlanabilir çünkü kolon zaten eklenmiş demektir.
var recoverableErrors = []string{
	"duplicate column name", // ALTER TABLE ADD COLUMN tekrar çalıştırılmış
}

// DB, veritabanı bağlantısını saran struct.
// *sql.DB Go'nun built-in connection pool'udur — thread-safe'dir,
// birden fazla goroutine aynı anda güvenle kullanabilir.
type DB struct {
	Conn *sql.DB
}

// New, yeni bir SQLite bağlantısı oluşturur ve migration'ları çalıştırır.
//
// dbPath: SQLite dosya yolu (ör: "./data/mqvi.db")
// migrationsFS: Migration SQL dosyalarını içeren fs.FS (embed.FS veya os.DirFS olabilir)
//
// Fonksiyon imzasındaki (*DB, error) Go'nun "multiple return value" özelliğidir.
// Başarılı olursa (*DB, nil), başarısızsa (nil, error) döner.
func New(dbPath string, migrationsFS fs.FS) (*DB, error) {
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
	if err := db.runMigrations(migrationsFS); err != nil {
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
//
// Migration tracking: schema_migrations tablosu hangi migration'ların zaten
// uygulandığını takip eder. Bu sayede ALTER TABLE gibi idempotent olmayan
// komutlar içeren migration'lar tekrar çalıştırılmaz.
//
// İlk çalıştırmada schema_migrations tablosu oluşturulur ve mevcut tüm
// migration'lar çalıştırılıp kaydedilir. Sonraki başlatmalarda sadece
// henüz uygulanmamış yeni migration'lar çalışır.
func (db *DB) runMigrations(migrationsFS fs.FS) error {
	// schema_migrations tablosunu oluştur — hangi migration'ların çalıştığını takip eder.
	// Bu tablo ilk kez oluşturuluyorsa ve DB'de zaten tablolar varsa (mevcut kurulum),
	// tüm migration dosyaları "applied" olarak işaretlenir (bootstrap).
	if _, err := db.Conn.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("failed to create schema_migrations table: %w", err)
	}

	// Migration dosyalarını oku (bootstrap için önce dosyalara ihtiyacımız var)
	// fs.ReadDir: io/fs paketinden — hem embed.FS hem os.DirFS ile çalışır.
	entries, err := fs.ReadDir(migrationsFS, ".")
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

	// Halihazırda uygulanmış migration'ları oku
	applied := make(map[string]bool)
	rows, err := db.Conn.Query("SELECT filename FROM schema_migrations")
	if err != nil {
		return fmt.Errorf("failed to query schema_migrations: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return fmt.Errorf("failed to scan migration row: %w", err)
		}
		applied[name] = true
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("failed to iterate migration rows: %w", err)
	}

	// Bootstrap: schema_migrations boşsa ama DB'de zaten tablolar varsa (mevcut kurulum),
	// tüm migration dosyalarını "applied" olarak kaydet. Bu sayede ALTER TABLE gibi
	// idempotent olmayan migration'lar tekrar çalıştırılmaz.
	if len(applied) == 0 {
		var tableCount int
		if err := db.Conn.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'",
		).Scan(&tableCount); err != nil {
			return fmt.Errorf("failed to check existing tables: %w", err)
		}

		if tableCount > 0 {
			// Mevcut kurulum — tüm migration'ları kaydedilmiş olarak işaretle
			for _, file := range sqlFiles {
				if _, err := db.Conn.Exec(
					"INSERT INTO schema_migrations (filename) VALUES (?)", file,
				); err != nil {
					return fmt.Errorf("failed to bootstrap migration %s: %w", file, err)
				}
				applied[file] = true
			}
			log.Printf("[database] bootstrapped %d existing migrations", len(sqlFiles))
			return nil
		}
	}

	for _, file := range sqlFiles {
		// Zaten uygulanmış migration'ı atla
		if applied[file] {
			continue
		}

		// fs.ReadFile: embed.FS'ten veya disk FS'ten okur — path separator gerekmez.
		content, err := fs.ReadFile(migrationsFS, file)
		if err != nil {
			return fmt.Errorf("failed to read migration %s: %w", file, err)
		}

		// Migration'ı statement-by-statement çalıştır.
		// SQLite Exec() birden fazla statement'ı kabul eder ama her biri ayrı
		// autocommit'tir — yarım kalan migration'ı kurtarmak için her statement'ı
		// ayrı çalıştırıp recoverable hatalar (ör. "duplicate column name") atlanır.
		if err := db.execStatements(file, string(content)); err != nil {
			return err
		}

		// Migration'ı uygulanmış olarak kaydet
		if _, err := db.Conn.Exec(
			"INSERT INTO schema_migrations (filename) VALUES (?)", file,
		); err != nil {
			return fmt.Errorf("failed to record migration %s: %w", file, err)
		}

		log.Printf("[database] migration applied: %s", file)
	}

	return nil
}

// execStatements, bir migration dosyasındaki SQL'i statement-by-statement çalıştırır.
// Her statement noktalı virgül (;) ile ayrılır. Bazı hatalar tolere edilir:
// örneğin "duplicate column name" — yarım kalan migration tekrar çalıştırıldığında
// ALTER TABLE ADD COLUMN zaten eklenmiş kolonu tekrar eklemeye çalışır.
// Bu güvenle atlanır çünkü kolon zaten mevcut demektir.
func (db *DB) execStatements(filename, content string) error {
	// SQL'i statement'lara böl (noktalı virgül ile)
	statements := splitStatements(content)

	for i, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}

		if _, err := db.Conn.Exec(stmt); err != nil {
			// Hata recoverable mi kontrol et
			errMsg := err.Error()
			recoverable := false
			for _, pattern := range recoverableErrors {
				if strings.Contains(errMsg, pattern) {
					recoverable = true
					break
				}
			}

			if recoverable {
				log.Printf("[database] %s: statement %d skipped (recoverable: %s)", filename, i+1, errMsg)
				continue
			}

			return fmt.Errorf("failed to execute migration %s (statement %d): %w", filename, i+1, err)
		}
	}

	return nil
}

// splitStatements, SQL metnini statement'lara böler.
// Noktalı virgül (;) ile ayırır ama string literal'lerin içindeki
// noktalı virgülleri (tek tırnak ile çevrili) yoksayar.
func splitStatements(sql string) []string {
	var statements []string
	var current strings.Builder
	inString := false

	for i := 0; i < len(sql); i++ {
		ch := sql[i]

		if ch == '\'' {
			// String literal toggle — '' (escape) handle et
			if inString && i+1 < len(sql) && sql[i+1] == '\'' {
				current.WriteByte(ch)
				current.WriteByte(sql[i+1])
				i++ // '' → iki tırnak yaz, skip
				continue
			}
			inString = !inString
		}

		if ch == ';' && !inString {
			s := strings.TrimSpace(current.String())
			if s != "" {
				statements = append(statements, s)
			}
			current.Reset()
			continue
		}

		current.WriteByte(ch)
	}

	// Son statement (noktalı virgülsüz bitmiş olabilir)
	s := strings.TrimSpace(current.String())
	if s != "" {
		statements = append(statements, s)
	}

	return statements
}
