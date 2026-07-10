package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	_ "modernc.org/sqlite"
)

func TestSQLiteServerReportRepo(t *testing.T) {
	ctx := context.Background()
	db := openMemDB(t, `
		CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
		CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT);
		CREATE TABLE server_reports (
			id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, server_id TEXT NOT NULL,
			reason TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
			resolved_by TEXT, resolved_at TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);`)
	repo := NewSQLiteServerReportRepo(db)

	if _, err := db.Exec(`INSERT INTO users (id, username) VALUES ('u1','alice');
		INSERT INTO servers (id, name) VALUES ('s1','Cool Server');`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	report := &models.ServerReport{
		ID: "r1", ReporterID: "u1", ServerID: "s1",
		Reason: models.ReportReasonSpam, Description: "spammy invites everywhere",
		Status: models.ReportStatusPending,
	}
	if err := repo.Create(ctx, report); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Dedup: a pending report from the same reporter for the same server is detectable.
	if has, _ := repo.HasPending(ctx, "u1", "s1"); !has {
		t.Fatal("HasPending should be true after a pending report")
	}
	if has, _ := repo.HasPending(ctx, "u1", "s2"); has {
		t.Fatal("HasPending should be false for a different server")
	}

	// Admin list enriches with reporter + server names.
	list, total, err := repo.ListForAdmin(ctx, "pending", 20, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 1 || len(list) != 1 {
		t.Fatalf("list total want 1, got %d/%d", total, len(list))
	}
	if list[0].ReporterUsername != "alice" || list[0].ServerName != "Cool Server" {
		t.Fatalf("list missing enriched names: %+v", list[0])
	}

	// Resolving clears it from the pending filter.
	if err := repo.UpdateStatus(ctx, "r1", models.ReportStatusResolved, "admin1"); err != nil {
		t.Fatalf("update status: %v", err)
	}
	if has, _ := repo.HasPending(ctx, "u1", "s1"); has {
		t.Fatal("HasPending should be false once resolved")
	}
	_, total, _ = repo.ListForAdmin(ctx, "pending", 20, 0)
	if total != 0 {
		t.Fatalf("pending list after resolve want 0, got %d", total)
	}
	// But still present in the unfiltered list.
	_, total, _ = repo.ListForAdmin(ctx, "", 20, 0)
	if total != 1 {
		t.Fatalf("all list want 1, got %d", total)
	}
}
