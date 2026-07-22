package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil/dbtest"
	_ "modernc.org/sqlite"
)

func TestDiscovery_ListFiltersAndOrder(t *testing.T) {
	ctx := context.Background()
	db := dbtest.New(t).DB
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`
		INSERT INTO users (id, username, password_hash) VALUES ('u1','alice','x'),('u2','bob','x');
		INSERT INTO servers (id, name, description, category, is_public, featured, deleted_at, owner_id) VALUES
			('s1','Cool Game Server','Best place for gamers','gaming',1,1,NULL,'u1'),
			('s2','Music Lounge','Chill beats','music',1,0,NULL,'u1'),
			('s3','Private Club','hidden','community',0,0,NULL,'u1'),
			('s4','Deleted Public','gone','gaming',1,0,'2020-01-01T00:00:00Z','u1'),
			('s5','Retro Gamers','Old school','gaming',1,0,NULL,'u1');
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
	db := dbtest.New(t).DB
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1','alice','x');
		INSERT INTO servers (id, name, category, is_public, discovery_blocked, owner_id) VALUES
		('s1','Listed','gaming',1,0,'u1'),
		('s2','Admin Blocked','gaming',1,1,'u1');`); err != nil {
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
	db := dbtest.New(t).DB
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1','alice','x');
		INSERT INTO servers (id, name, description, category, is_public, owner_id) VALUES
		('s1','Cool Game Server','Best place for gamers','gaming',1,'u1'),
		('s2','Music Lounge','Chill beats','music',1,'u1');`); err != nil {
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
	db := dbtest.New(t).DB
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`
		INSERT INTO users (id, username, password_hash) VALUES ('u1','alice','x');
		INSERT INTO servers (id, name, category, is_public, deleted_at, owner_id) VALUES
			('s1','Public One','gaming',1,NULL,'u1'),
			('s2','Private One','gaming',0,NULL,'u1'),
			('s3','Deleted One','gaming',1,'2020-01-01T00:00:00Z','u1');
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

// TestServersFTS_UpdateAndDelete guards the external-content FTS triggers: an owner editing
// a server's description must not fail, and the index must reflect the new text.
func TestServersFTS_UpdateAndDelete(t *testing.T) {
	ctx := context.Background()
	db := dbtest.New(t).DB
	repo := NewSQLiteDiscoveryRepo(db)

	if _, err := db.Exec(`
		INSERT INTO users (id, username, password_hash) VALUES ('u1','alice','x');
		INSERT INTO servers (id, name, description, is_public, owner_id) VALUES ('s1','Alpha','old text',1,'u1');
		INSERT INTO server_members (server_id, user_id) VALUES ('s1','u1');`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := db.Exec(`UPDATE servers SET description = 'brand new text' WHERE id = 's1'`); err != nil {
		t.Fatalf("updating a description must not fail: %v", err)
	}

	page, err := repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", Search: "brand", Limit: 20})
	if err != nil {
		t.Fatalf("search after update: %v", err)
	}
	if page.Total != 1 {
		t.Fatalf("new description must be searchable, got %d hits", page.Total)
	}

	page, err = repo.ListPublicServers(ctx, models.PublicServerListParams{RequestingUserID: "u1", Search: "old text", Limit: 20})
	if err != nil {
		t.Fatalf("search stale term: %v", err)
	}
	if page.Total != 0 {
		t.Fatalf("old description must be gone from the index, got %d hits", page.Total)
	}

	if _, err := db.Exec(`DELETE FROM servers WHERE id = 's1'`); err != nil {
		t.Fatalf("deleting a server must not fail: %v", err)
	}
}
