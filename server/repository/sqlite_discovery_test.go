package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	_ "modernc.org/sqlite"
)

const discoverySchema = `
CREATE TABLE servers (
	id TEXT PRIMARY KEY, name TEXT NOT NULL, icon_url TEXT, banner_url TEXT,
	description TEXT, category TEXT,
	is_public INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0,
	featured INTEGER NOT NULL DEFAULT 0, approval_required INTEGER NOT NULL DEFAULT 0,
	discovery_blocked INTEGER NOT NULL DEFAULT 0,
	deleted_at TEXT
);
CREATE TABLE server_members (server_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(server_id,user_id));
CREATE VIRTUAL TABLE servers_fts USING fts5(name, description, content='servers', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER servers_ai AFTER INSERT ON servers BEGIN
	INSERT INTO servers_fts(rowid, name, description) VALUES (NEW.rowid, NEW.name, COALESCE(NEW.description,''));
END;
CREATE TRIGGER servers_au AFTER UPDATE OF name, description ON servers BEGIN
	DELETE FROM servers_fts WHERE rowid = OLD.rowid;
	INSERT INTO servers_fts(rowid, name, description) VALUES (NEW.rowid, NEW.name, COALESCE(NEW.description,''));
END;
CREATE TRIGGER servers_ad AFTER DELETE ON servers BEGIN
	DELETE FROM servers_fts WHERE rowid = OLD.rowid;
END;`

func TestDiscovery_ListFiltersAndOrder(t *testing.T) {
	ctx := context.Background()
	db := openMemDB(t, discoverySchema)
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`
		INSERT INTO servers (id, name, description, category, is_public, featured, deleted_at) VALUES
			('s1','Cool Game Server','Best place for gamers','gaming',1,1,NULL),
			('s2','Music Lounge','Chill beats','music',1,0,NULL),
			('s3','Private Club','hidden','community',0,0,NULL),
			('s4','Deleted Public','gone','gaming',1,0,'2020-01-01T00:00:00Z'),
			('s5','Retro Gamers','Old school','gaming',1,0,NULL);
		INSERT INTO server_members (server_id, user_id) VALUES
			('s1','u1'),('s1','u2'),('s2','u2'),('s5','u1');`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// No filter: only public + non-deleted (s1,s2,s5); featured first, then member_count, then id.
	page, err := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", Limit: 20})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if page.Total != 3 {
		t.Fatalf("total want 3 (public, non-deleted) got %d", page.Total)
	}
	if page.Items[0].ID != "s1" {
		t.Fatalf("featured server must sort first, got %s", page.Items[0].ID)
	}
	if page.Items[0].MemberCount != 2 {
		t.Fatalf("s1 member_count want 2 got %d", page.Items[0].MemberCount)
	}
	if !page.Items[0].IsMember {
		t.Fatal("u1 is a member of s1 → is_member must be true")
	}
	// s2 has no u1 membership.
	for _, it := range page.Items {
		if it.ID == "s2" && it.IsMember {
			t.Fatal("u1 is not a member of s2 → is_member must be false")
		}
	}

	// Category filter.
	gaming, _ := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", Category: "gaming", Limit: 20})
	if gaming.Total != 2 {
		t.Fatalf("gaming total want 2 (s1,s5) got %d", gaming.Total)
	}

	// FeaturedOnly.
	feat, _ := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", FeaturedOnly: true, Limit: 20})
	if feat.Total != 1 || feat.Items[0].ID != "s1" {
		t.Fatalf("featured-only want [s1] got total=%d", feat.Total)
	}

	// ExcludeFeatured (home main grid): the featured s1 must not appear.
	nonFeat, _ := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", ExcludeFeatured: true, Limit: 20})
	if nonFeat.Total != 2 {
		t.Fatalf("exclude-featured want 2 (s2,s5) got %d", nonFeat.Total)
	}
	for _, it := range nonFeat.Items {
		if it.ID == "s1" {
			t.Fatal("featured server must be excluded when ExcludeFeatured is set")
		}
	}
}

func TestDiscovery_BlockedExcluded(t *testing.T) {
	ctx := context.Background()
	db := openMemDB(t, discoverySchema)
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`INSERT INTO servers (id, name, category, is_public, discovery_blocked) VALUES
		('s1','Listed','gaming',1,0),
		('s2','Admin Blocked','gaming',1,1);`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	page, _ := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", Limit: 20})
	if page.Total != 1 || page.Items[0].ID != "s1" {
		t.Fatalf("admin-blocked server must be excluded from discovery; got total=%d", page.Total)
	}
	// Also not retrievable as a single preview.
	if _, err := repo.GetPublicServerItem(ctx, "s2", "u1"); err == nil {
		t.Fatal("admin-blocked server must not be retrievable via discovery")
	}
}

func TestDiscovery_FTSSearch(t *testing.T) {
	ctx := context.Background()
	db := openMemDB(t, discoverySchema)
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`INSERT INTO servers (id, name, description, category, is_public) VALUES
		('s1','Cool Game Server','Best place for gamers','gaming',1),
		('s2','Music Lounge','Chill beats','music',1);`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Substring match on name via trigram FTS (>= 3 chars).
	byName, _ := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", Search: "Lounge", Limit: 20})
	if byName.Total != 1 || byName.Items[0].ID != "s2" {
		t.Fatalf("search 'Lounge' want [s2] got total=%d", byName.Total)
	}

	// Substring match on description.
	byDesc, _ := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", Search: "gamers", Limit: 20})
	if byDesc.Total != 1 || byDesc.Items[0].ID != "s1" {
		t.Fatalf("search 'gamers' want [s1] got total=%d", byDesc.Total)
	}

	// Short query (< 3 chars) falls back to name LIKE.
	short, _ := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", Search: "Co", Limit: 20})
	if short.Total != 1 || short.Items[0].ID != "s1" {
		t.Fatalf("short search 'Co' want [s1] got total=%d", short.Total)
	}
}

func TestDiscovery_GetPublicServerItem(t *testing.T) {
	ctx := context.Background()
	db := openMemDB(t, discoverySchema)
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`
		INSERT INTO servers (id, name, category, is_public, deleted_at) VALUES
			('s1','Public One','gaming',1,NULL),
			('s2','Private One','gaming',0,NULL),
			('s3','Deleted One','gaming',1,'2020-01-01T00:00:00Z');
		INSERT INTO server_members (server_id, user_id) VALUES ('s1','u1');`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	item, err := repo.GetPublicServerItem(ctx, "s1", "u1")
	if err != nil {
		t.Fatalf("get public s1: %v", err)
	}
	if item.ID != "s1" || !item.IsMember || item.MemberCount != 1 {
		t.Fatalf("unexpected item: %+v", item)
	}

	// A private server is not retrievable via discovery.
	if _, err := repo.GetPublicServerItem(ctx, "s2", "u1"); err == nil {
		t.Fatal("private server must not be retrievable via discovery")
	}
	// A deleted server is not retrievable.
	if _, err := repo.GetPublicServerItem(ctx, "s3", "u1"); err == nil {
		t.Fatal("deleted server must not be retrievable via discovery")
	}
}
