package repository

import (
	"context"
	"testing"

	"github.com/akinalp/mqvi/testutil/dbtest"
)

// The test database is built by running every migration on an empty schema, so 096 has already
// run when a fixture starts: a user created now is a new account and must see the guide.
func TestGuide_NewAccountsSeeTheGuide(t *testing.T) {
	f := dbtest.New(t)
	me := f.User("me")

	got, err := NewSQLiteGuideRepo(f.DB).GetState(context.Background(), me)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if got.Hidden {
		t.Fatal("an account created after the migrations must see the guide")
	}
}
