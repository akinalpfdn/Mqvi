package services

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func (q *keyedSerialQueue) idle(key string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	_, active := q.pending[key]
	return !active
}

// A server's voice events must reach clients in the order they happened: a leave overtaking its
// join leaves a ghost participant on every screen.
func TestKeyedSerialQueue_RunsAKeysTasksInOrder(t *testing.T) {
	q := newKeyedSerialQueue(nil)
	var mu sync.Mutex
	var got []int
	for i := range 500 {
		q.run("srv", func() {
			mu.Lock()
			got = append(got, i)
			mu.Unlock()
		})
	}
	waitFor(t, "500 tasks", func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 500 })
	for i, v := range got {
		if v != i {
			t.Fatalf("task %d ran at position %d", v, i)
		}
	}
}

// One server's slow audience resolution must not hold up another server's events.
func TestKeyedSerialQueue_KeysDoNotBlockEachOther(t *testing.T) {
	q := newKeyedSerialQueue(nil)
	release := make(chan struct{})
	q.run("slow", func() { <-release })

	done := make(chan struct{})
	q.run("other", func() { close(done) })
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a blocked server stalled another server's queue")
	}
	close(release)
}

// The worker exists only while there is work; a drained key leaves no goroutine behind and the next
// task starts a new one.
func TestKeyedSerialQueue_WorkerExitsWhenDrainedAndRestarts(t *testing.T) {
	q := newKeyedSerialQueue(nil)
	ran := make(chan struct{}, 2)
	q.run("srv", func() { ran <- struct{}{} })
	<-ran
	waitFor(t, "worker exit", func() bool { return q.idle("srv") })

	q.run("srv", func() { ran <- struct{}{} })
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("work queued after a drain never ran")
	}
}

// A task that panics must not take the process down or swallow the server's later events.
func TestKeyedSerialQueue_PanicDoesNotStopTheQueue(t *testing.T) {
	q := newKeyedSerialQueue(nil)
	q.run("srv", func() { panic("boom") })
	done := make(chan struct{})
	q.run("srv", func() { close(done) })
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the task after a panic never ran")
	}
}

// A panicking task still leaves the count, or every later depth would be inflated by one.
func TestKeyedSerialQueue_DepthRecoversAfterAPanic(t *testing.T) {
	q := newKeyedSerialQueue(nil)
	q.run("srv", func() { panic("boom") })
	done := make(chan struct{})
	q.run("srv", func() { close(done) })
	<-done
	waitFor(t, "drain", func() bool { return q.idle("srv") })

	q.mu.Lock()
	defer q.mu.Unlock()
	if n := q.outstanding["srv"]; n != 0 {
		t.Fatalf("outstanding after the queue drained = %d, want 0", n)
	}
}

// Many writers enqueueing at once (every voice change does it under s.mu, from many goroutines).
// Meaningful under -race.
func TestKeyedSerialQueue_ConcurrentEnqueue(t *testing.T) {
	q := newKeyedSerialQueue(nil)
	var mu sync.Mutex
	count := 0
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 50 {
				q.run("srv", func() { mu.Lock(); count++; mu.Unlock() })
			}
		}()
	}
	wg.Wait()
	waitFor(t, "1000 tasks", func() bool { mu.Lock(); defer mu.Unlock(); return count == 1000 })
}

// End to end through the real queue: a viewer sees one user's changes in the order they happened,
// though the audience is resolved on another goroutine.
func TestVoiceEgress_DeliversInOrderThroughTheQueue(t *testing.T) {
	log := &deliveryLog{}
	view := &viewTable{online: []string{"watcher"}, viewers: map[string][]string{openCh: {"watcher", "u1"}}}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: audServer, Type: models.ChannelTypeVoice}, nil
		}},
		&mockLiveKitGetter{}, nil,
		&testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
			return models.PermAll, nil
		}},
		log.broadcaster(), view, view, nil, nil, nil, &testutil.MockFileURLSigner{},
		nil,
	)

	yes, no := true, false
	if err := svc.JoinChannel("u1", "u1", "u1", "", openCh, false, false); err != nil {
		t.Fatal(err)
	}
	for range 20 {
		_ = svc.UpdateState("u1", &yes, nil, nil, nil)
		_ = svc.UpdateState("u1", &no, nil, nil, nil)
	}
	_ = svc.LeaveChannel("u1")

	want := 1 + 1 + 40 + 1 + 1 // join, timer start, 40 updates, leave, timer stop
	waitFor(t, "every event", func() bool { return len(log.to("watcher")) == want })

	got := log.to("watcher")
	if d := got[0].Data.(ws.VoiceStateUpdateBroadcast); d.Action != "join" {
		t.Fatalf("first event %s, want the join", opsOf(got[:1]))
	}
	for i := 2; i < 42; i++ {
		d := got[i].Data.(ws.VoiceStateUpdateBroadcast)
		if wantMuted := i%2 == 0; d.Action != "update" || d.IsMuted != wantMuted {
			t.Fatalf("event %d is %s muted=%v; order lost", i, d.Action, d.IsMuted)
		}
	}
	if d := got[42].Data.(ws.VoiceStateUpdateBroadcast); d.Action != "leave" {
		t.Fatalf("event 42 %s, want the leave", opsOf(got[42:43]))
	}
}

// Every voice event leaves through the egress, which decides who may see it. A direct hub
// broadcast added to a voice file would skip that and reach the whole server — this keeps the
// voice files from calling the hub at all.
func TestVoiceFiles_BroadcastOnlyThroughTheEgress(t *testing.T) {
	allowed := map[string]bool{
		"voice_egress.go":          true, // the one place that talks to the hub
		"voice_message_service.go": true, // a separate service; sends to the channel's participants only
	}
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		n := fi.Name()
		return strings.HasPrefix(n, "voice_") && !strings.HasSuffix(n, "_test.go") && !allowed[n]
	}, 0)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	checked := 0
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			checked++
			ast.Inspect(file, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || !strings.HasPrefix(sel.Sel.Name, "Broadcast") {
					return true
				}
				t.Errorf("%s:%d calls %s directly; voice events must go through s.egress", name, fset.Position(sel.Pos()).Line, sel.Sel.Name)
				return true
			})
		}
	}
	if checked < 8 {
		t.Fatalf("checked only %d voice files — the filter is not finding them", checked)
	}
}
