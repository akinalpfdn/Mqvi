package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// deleteGuardRepo is the slice of LiveKitRepository this test needs; everything else panics loudly
// so a change in what DeleteInstance touches shows up rather than passing silently.
type deleteGuardRepo struct {
	repository.LiveKitRepository
	inst      *models.LiveKitInstance
	liveCalls int
	deleted   bool
}

func (r *deleteGuardRepo) GetByID(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	return r.inst, nil
}

func (r *deleteGuardRepo) CountChannelBindings(_ context.Context, _ string) (int, error) {
	return r.liveCalls, nil
}

func (r *deleteGuardRepo) Delete(_ context.Context, _ string) error {
	r.deleted = true
	return nil
}

// server_count is no longer a proxy for "is anything happening on this instance". Placement became
// per-channel and by region, so a freshly added region carries live calls with zero servers
// registered against it — and being empty by that measure is exactly what makes it the preferred
// target for new calls. Deleting it cascades channel_voice_bindings away, so the calls in progress
// rebind and the next joiner opens a same-named room on a different SFU: both halves work, neither
// hears the other, and nothing errors.
func TestDeleteInstance_RefusesWhileCallsAreRunningOnIt(t *testing.T) {
	repo := &deleteGuardRepo{
		inst:      &models.LiveKitInstance{ID: "lk-new-region", IsPlatformManaged: true, ServerCount: 0},
		liveCalls: 2,
	}
	svc := &livekitAdminService{livekitRepo: repo}

	err := svc.DeleteInstance(context.Background(), "lk-new-region", "")
	if err == nil {
		t.Fatal("deleted an instance that was hosting live calls")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("err = %v, want a bad-request refusal", err)
	}
	if !strings.Contains(err.Error(), "2") {
		t.Errorf("refusal does not say how many calls are running: %v", err)
	}
	if repo.deleted {
		t.Error("the instance was deleted despite the refusal")
	}
}

func TestDeleteInstance_AllowsAnIdleInstance(t *testing.T) {
	repo := &deleteGuardRepo{
		inst:      &models.LiveKitInstance{ID: "lk-idle", IsPlatformManaged: true, ServerCount: 0},
		liveCalls: 0,
	}
	svc := &livekitAdminService{livekitRepo: repo}

	if err := svc.DeleteInstance(context.Background(), "lk-idle", ""); err != nil {
		t.Fatalf("an idle instance could not be deleted: %v", err)
	}
	if !repo.deleted {
		t.Error("delete was never reached")
	}
}
