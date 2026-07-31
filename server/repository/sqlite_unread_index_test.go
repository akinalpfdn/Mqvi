package repository

import (
	"context"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/testutil/dbtest"
)

// The index is the whole of phase 54: without it the UPDATE behind every single message sent
// scans channel_reads end to end, because the primary key leads with user_id and this predicate
// does not.
func TestIncrementUnreadCounts_UsesTheChannelIndex(t *testing.T) {
	ctx := context.Background()
	f := dbtest.New(t)

	rows, err := f.DB.QueryContext(ctx,
		`EXPLAIN QUERY PLAN UPDATE channel_reads SET unread_count = unread_count + 1
		 WHERE channel_id = 'c1' AND user_id != 'u1'`)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer rows.Close()

	var plan strings.Builder
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan plan: %v", err)
		}
		plan.WriteString(detail)
		plan.WriteString("\n")
	}

	if !strings.Contains(plan.String(), "idx_channel_reads_channel") {
		t.Fatalf("increment does not use the channel index, plan was:\n%s", plan.String())
	}
}
