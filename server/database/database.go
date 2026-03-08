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

	_ "modernc.org/sqlite" // pure-Go SQLite driver (no CGO)
)

// recoverableErrors lists error patterns that can be safely skipped
// when re-running a partially applied migration (e.g. "duplicate column name").
var recoverableErrors = []string{
	"duplicate column name",
}

type DB struct {
	Conn *sql.DB
}

// New opens a SQLite connection and runs pending migrations.
func New(dbPath string, migrationsFS fs.FS) (*DB, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	// foreign_keys=on (off by default in SQLite), journal_mode=WAL for concurrent r/w
	conn, err := sql.Open("sqlite", dbPath+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	db := &DB{Conn: conn}

	if err := db.runMigrations(migrationsFS); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	log.Println("[database] connected and migrations applied")
	return db, nil
}

func (db *DB) Close() error {
	return db.Conn.Close()
}

// runMigrations applies SQL files from migrationsFS in alphabetical order.
// Uses schema_migrations table to track which files have been applied.
func (db *DB) runMigrations(migrationsFS fs.FS) error {
	if _, err := db.Conn.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("failed to create schema_migrations table: %w", err)
	}

	entries, err := fs.ReadDir(migrationsFS, ".")
	if err != nil {
		return fmt.Errorf("failed to read migrations directory: %w", err)
	}

	var sqlFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			sqlFiles = append(sqlFiles, entry.Name())
		}
	}

	sort.Strings(sqlFiles)

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

	// Bootstrap: if schema_migrations is empty but tables already exist,
	// mark all migrations as applied to avoid re-running ALTER TABLE etc.
	if len(applied) == 0 {
		var tableCount int
		if err := db.Conn.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'",
		).Scan(&tableCount); err != nil {
			return fmt.Errorf("failed to check existing tables: %w", err)
		}

		if tableCount > 0 {
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
		if applied[file] {
			continue
		}

		content, err := fs.ReadFile(migrationsFS, file)
		if err != nil {
			return fmt.Errorf("failed to read migration %s: %w", file, err)
		}

		if err := db.execStatements(file, string(content)); err != nil {
			return err
		}

		if _, err := db.Conn.Exec(
			"INSERT INTO schema_migrations (filename) VALUES (?)", file,
		); err != nil {
			return fmt.Errorf("failed to record migration %s: %w", file, err)
		}

		log.Printf("[database] migration applied: %s", file)
	}

	return nil
}

// execStatements runs each SQL statement individually, skipping recoverable errors
// (e.g. "duplicate column name" from a partially applied migration).
func (db *DB) execStatements(filename, content string) error {
	statements := splitStatements(content)

	for i, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}

		if _, err := db.Conn.Exec(stmt); err != nil {
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

// splitStatements splits SQL by semicolons, respecting string literals
// and BEGIN...END blocks (for triggers).
func splitStatements(sql string) []string {
	var statements []string
	var current strings.Builder
	inString := false
	beginDepth := 0

	for i := 0; i < len(sql); i++ {
		ch := sql[i]

		if ch == '\'' {
			if inString && i+1 < len(sql) && sql[i+1] == '\'' {
				current.WriteByte(ch)
				current.WriteByte(sql[i+1])
				i++
				continue
			}
			inString = !inString
		}

		if !inString {
			if matchKeyword(sql, i, "BEGIN") {
				beginDepth++
			}
			if matchKeyword(sql, i, "END") && beginDepth > 0 {
				beginDepth--
			}
		}

		if ch == ';' && !inString && beginDepth == 0 {
			s := strings.TrimSpace(current.String())
			if s != "" {
				statements = append(statements, s)
			}
			current.Reset()
			continue
		}

		current.WriteByte(ch)
	}

	s := strings.TrimSpace(current.String())
	if s != "" {
		statements = append(statements, s)
	}

	return statements
}

// matchKeyword checks for a case-insensitive keyword at the given position
// with word-boundary checks on both sides.
func matchKeyword(sql string, pos int, keyword string) bool {
	if pos+len(keyword) > len(sql) {
		return false
	}
	if pos > 0 && isIdentChar(sql[pos-1]) {
		return false
	}
	for j := 0; j < len(keyword); j++ {
		c := sql[pos+j]
		if c >= 'a' && c <= 'z' {
			c -= 32
		}
		if c != keyword[j] {
			return false
		}
	}
	afterIdx := pos + len(keyword)
	if afterIdx < len(sql) && isIdentChar(sql[afterIdx]) {
		return false
	}
	return true
}

func isIdentChar(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '_'
}
