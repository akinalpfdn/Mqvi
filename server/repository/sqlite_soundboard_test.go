package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/testutil/dbtest"

	_ "modernc.org/sqlite"
)

// The panel now offers the sounds of every server the user is in, so this query is the only
// thing deciding which servers those are. It has to answer for three things at once:
// membership, soft-deleted servers, and not handing back the same sound twice.
func TestSoundboard_ListForUser(t *testing.T) {
	ctx := context.Background()
	db := dbtest.New(t).DB
	repo := NewSQLiteSoundboardRepo(db)

	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("exec %q: %v", q, err)
		}
	}
	exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1','me','x'), ('u2','someone','x')`)
	exec(`INSERT INTO servers (id, name, owner_id, deleted_at) VALUES
		('s-a','Alpha','u1',NULL), ('s-b','Bravo','u1',NULL), ('s-c','Charlie','u1',NULL), ('s-d','Deleted','u1','2026-01-01')`)
	// Member of A, B and the deleted D. NOT a member of C.
	exec(`INSERT INTO server_members (server_id,user_id) VALUES ('s-a','u1'), ('s-b','u1'), ('s-d','u1'), ('s-c','u2')`)

	sound := func(id, server, name string) {
		t.Helper()
		exec(`INSERT INTO soundboard_sounds (id,server_id,name,file_url,file_size,duration_ms,uploaded_by)
		      VALUES (?,?,?,?,1,1000,'u1')`, id, server, name, "/api/files/soundboards/"+server+"/"+id+".wav")
	}
	sound("a2", "s-a", "zebra")
	sound("a1", "s-a", "airhorn")
	sound("b1", "s-b", "bruh")
	sound("c1", "s-c", "not mine")   // a server the user is not in
	sound("d1", "s-d", "gone")       // a server that was deleted

	got, err := repo.ListForUser(ctx, "u1")
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}

	var ids []string
	for _, s := range got {
		ids = append(ids, s.ID)
	}

	// Grouped by server, alphabetical inside it — the client renders the sections in this order.
	want := []string{"a1", "a2", "b1"}
	if len(ids) != len(want) {
		t.Fatalf("got %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("got %v, want %v", ids, want)
		}
	}

	for _, s := range got {
		if s.ID == "c1" {
			t.Error("a sound from a server the user is not a member of was handed to them")
		}
		if s.ID == "d1" {
			t.Error("a soft-deleted server's sounds are still being offered")
		}
		if s.UploaderUsername != "me" {
			t.Errorf("uploader not joined: %+v", s)
		}
	}
}

// A user in two servers must not see a sound twice. The join is on membership, and a row per
// membership would duplicate every sound the day server_members grows a second row per user.
func TestSoundboard_ListForUser_NoDuplicates(t *testing.T) {
	ctx := context.Background()
	db := dbtest.New(t).DB
	repo := NewSQLiteSoundboardRepo(db)

	if _, err := db.Exec(`
		INSERT INTO users (id, username, password_hash) VALUES ('u1','me','x');
		INSERT INTO servers (id, name, owner_id) VALUES ('s-a','Alpha','u1');
		INSERT INTO server_members (server_id,user_id) VALUES ('s-a','u1');
		INSERT INTO soundboard_sounds (id,server_id,name,file_url,file_size,duration_ms,uploaded_by)
		VALUES ('a1','s-a','airhorn','/f.wav',1,1000,'u1');`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := repo.ListForUser(ctx, "u1")
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d rows for one sound, want 1", len(got))
	}
}
