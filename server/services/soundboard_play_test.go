package services

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

// ─── fakes ───

type sbHub struct {
	fakeHub
	mu   sync.Mutex
	sent []ws.Event
}

func (h *sbHub) BroadcastToUsers(_ []string, e ws.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sent = append(h.sent, e)
}

func (h *sbHub) plays() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, e := range h.sent {
		if e.Op == ws.OpSoundboardPlay {
			n++
		}
	}
	return n
}

// Only GetByID is exercised; the rest exist to satisfy the repository interface.
type sbRepo struct {
	sound *models.SoundboardSound
}

func (r *sbRepo) Create(context.Context, *models.SoundboardSound) error { return nil }
func (r *sbRepo) GetByID(_ context.Context, id string) (*models.SoundboardSound, error) {
	if r.sound == nil || r.sound.ID != id {
		return nil, pkg.ErrNotFound
	}
	return r.sound, nil
}
func (r *sbRepo) ListByServer(context.Context, string) ([]models.SoundboardSound, error) {
	return nil, nil
}
func (r *sbRepo) ListForUser(context.Context, string) ([]models.SoundboardSound, error) {
	return nil, nil
}
func (r *sbRepo) Update(context.Context, *models.SoundboardSound) error { return nil }
func (r *sbRepo) Delete(context.Context, string) error                 { return nil }
func (r *sbRepo) CountByServer(context.Context, string) (int, error)   { return 0, nil }

type sbVoice struct{ state *models.VoiceState }

func (v *sbVoice) GetUserVoiceState(string) *models.VoiceState { return v.state }
func (v *sbVoice) GetChannelParticipants(string) []models.VoiceState {
	if v.state == nil {
		return nil
	}
	return []models.VoiceState{*v.state}
}

// Permissions per channel — the whole point is that they differ from the sound's server.
type sbPerms struct {
	byChannel map[string]models.Permission
	err       error
}

func (p *sbPerms) ResolveChannelPermissions(_ context.Context, _, channelID string) (models.Permission, error) {
	if p.err != nil {
		return 0, p.err
	}
	return p.byChannel[channelID], nil
}

type sbSigner struct{}

func (sbSigner) SignURL(u string) string { return u + "?sig=x" }
func (sbSigner) SignURLPtr(u *string) *string {
	return u
}

// A sound owned by server A, a user speaking in server B's voice channel.
func sbService(perms map[string]models.Permission, inVoice bool) (*soundboardService, *sbHub) {
	hub := &sbHub{}
	var state *models.VoiceState
	if inVoice {
		state = &models.VoiceState{UserID: "u1", ChannelID: "chan-B", ServerID: "server-B"}
	}
	svc := &soundboardService{
		repo:         &sbRepo{sound: &models.SoundboardSound{ID: "snd", ServerID: "server-A", Name: "airhorn"}},
		hub:          hub,
		voice:        &sbVoice{state: state},
		channelPerms: &sbPerms{byChannel: perms},
		urlSigner:    sbSigner{},
	}
	return svc, hub
}

// ─── tests ───

// The point of the feature: a sound from one server can be played into another server's voice
// channel, because that is where the user actually is.
func TestPlay_SoundFromAnotherServerIsAllowedWhereTheUserIsSpeaking(t *testing.T) {
	svc, hub := sbService(map[string]models.Permission{"chan-B": models.PermUseSoundboard}, true)

	if err := svc.Play(context.Background(), "server-A", "snd", "u1", "u1"); err != nil {
		t.Fatalf("Play: %v", err)
	}
	if hub.plays() != 1 {
		t.Fatalf("the voice channel heard %d sounds, want 1", hub.plays())
	}
}

// The bug this closes. Permission used to be checked ONLY on the server that owns the sound,
// and never on the channel the noise comes out of — so a user barred from the soundboard in
// the server whose voice channel they are sitting in could still blast it, just by reaching
// for a sound from somewhere else. Cross-server listing turns that from an oddity into a
// one-tap feature, so it has to be shut first.
func TestPlay_DeniedWhenTheChannelBeingPlayedIntoForbidsIt(t *testing.T) {
	// The user has every permission in the world in server A — and none in the channel they
	// are actually in.
	svc, hub := sbService(map[string]models.Permission{"chan-B": 0}, true)

	err := svc.Play(context.Background(), "server-A", "snd", "u1", "u1")

	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("got %v, want ErrForbidden — the channel the sound plays into decides", err)
	}
	if hub.plays() != 0 {
		t.Fatal("the sound was broadcast into a channel that forbids the soundboard")
	}
}

// Admin bypasses every permission check in this codebase. Today the resolver already hands
// back PermAll for an admin, so a raw bit test would happen to pass — this pins the guard to
// Has() so it keeps passing the day that stops being true.
func TestPlay_AdminMayUseTheSoundboardWithoutTheSoundboardBit(t *testing.T) {
	svc, hub := sbService(map[string]models.Permission{"chan-B": models.PermAdmin}, true)

	if err := svc.Play(context.Background(), "server-A", "snd", "u1", "u1"); err != nil {
		t.Fatalf("an admin was refused the soundboard: %v", err)
	}
	if hub.plays() != 1 {
		t.Fatal("an admin's sound never reached the channel")
	}
}

// A channel override can revoke it on its own, without touching the server's roles.
func TestPlay_DeniedByAChannelOverrideEvenWhenTheServerAllowsIt(t *testing.T) {
	svc, hub := sbService(map[string]models.Permission{
		"chan-B": models.PermSpeak | models.PermConnectVoice, // everything but the soundboard
	}, true)

	if err := svc.Play(context.Background(), "server-A", "snd", "u1", "u1"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("got %v, want ErrForbidden", err)
	}
	if hub.plays() != 0 {
		t.Fatal("a channel override that removed PermUseSoundboard did not stop the sound")
	}
}

// Fail closed: a permission lookup that errors must not fall through to a broadcast.
func TestPlay_DeniedWhenThePermissionLookupFails(t *testing.T) {
	hub := &sbHub{}
	svc := &soundboardService{
		repo:         &sbRepo{sound: &models.SoundboardSound{ID: "snd", ServerID: "server-A"}},
		hub:          hub,
		voice:        &sbVoice{state: &models.VoiceState{UserID: "u1", ChannelID: "chan-B", ServerID: "server-B"}},
		channelPerms: &sbPerms{err: errors.New("db is down")},
		urlSigner:    sbSigner{},
	}

	if err := svc.Play(context.Background(), "server-A", "snd", "u1", "u1"); err == nil {
		t.Fatal("a failed permission lookup let the sound through")
	}
	if hub.plays() != 0 {
		t.Fatal("the sound was broadcast despite the permission lookup failing")
	}
}

func TestPlay_RejectedWhenNotInAVoiceChannel(t *testing.T) {
	svc, hub := sbService(map[string]models.Permission{"chan-B": models.PermUseSoundboard}, false)

	if err := svc.Play(context.Background(), "server-A", "snd", "u1", "u1"); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("got %v, want ErrBadRequest", err)
	}
	if hub.plays() != 0 {
		t.Fatal("a sound was played with nobody in a voice channel to hear it")
	}
}

// The sound must belong to the server named in the path — the route only proves membership of
// that server, so this is what stops a member of A reaching a sound in a server they left.
func TestPlay_RejectsASoundThatIsNotInTheNamedServer(t *testing.T) {
	svc, hub := sbService(map[string]models.Permission{"chan-B": models.PermUseSoundboard}, true)

	if err := svc.Play(context.Background(), "server-C", "snd", "u1", "u1"); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("got %v, want ErrBadRequest", err)
	}
	if hub.plays() != 0 {
		t.Fatal("a sound was played through a server it does not belong to")
	}
}
