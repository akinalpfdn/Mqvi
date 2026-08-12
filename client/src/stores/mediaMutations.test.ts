/**
 * Voice-channel chat and soundboard mutations that no longer wait for the WebSocket.
 *
 * Both lists were pure WS mirrors: the sender's own voice message and the uploader's own sound only
 * appeared when the event came back. Voice chat is the worst place for that — it is ephemeral, so
 * there is no reload that fixes it, and a message that never appears reads as one that never sent.
 *
 * `handleSoundCreate` needed the same idempotency fix as `handleChannelCreate` before it could be
 * reused here; the voice-message handlers already dedup by id.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VoiceMessage, SoundboardSound } from "../types";

const voiceApi = vi.hoisted(() => ({
  listVoiceMessages: vi.fn(),
  sendVoiceMessage: vi.fn(),
  editVoiceMessage: vi.fn(),
  deleteVoiceMessage: vi.fn(),
}));
vi.mock("../api/voiceMessages", () => voiceApi);

const soundApi = vi.hoisted(() => ({
  getAllSounds: vi.fn(),
  createSound: vi.fn(),
  deleteSound: vi.fn(),
  updateSound: vi.fn(),
  playSound: vi.fn(),
}));
vi.mock("../api/soundboard", () => soundApi);
// soundboardStore subscribes to voice at module load to stop playback on leave.
vi.mock("./voiceStore", () => ({
  useVoiceStore: { getState: () => ({ currentVoiceChannelId: null }), subscribe: () => () => {} },
}));

const { useVoiceMessageStore } = await import("./voiceMessageStore");
const { useSoundboardStore } = await import("./soundboardStore");

const ok = <T,>(data: T) => ({ success: true as const, data });
const fail = (error?: string) => ({ success: false as const, error });

// VoiceMessage has twenty-four fields (author, attachments, reactions, timestamps); the store keys
// on `id` and `channel_id` and stores the rest untouched. SoundboardSound below is built in full
// because it is small enough that a partial does not even satisfy the compiler.
const vmsg = (id: string, content = id): VoiceMessage =>
  ({ id, channel_id: "vc1", content, user_id: "u1" }) as VoiceMessage;

const sound = (id: string, name = id): SoundboardSound => ({
  id,
  name,
  server_id: "s1",
  emoji: null,
  file_url: `/s/${id}.mp3`,
  file_size: 1024,
  duration_ms: 1000,
  uploaded_by: "u1",
  created_at: "2026-01-01T00:00:00Z",
});

const voiceIds = () =>
  (useVoiceMessageStore.getState().messagesByChannel["vc1"] ?? []).map((m) => m.id);
const soundIds = () => useSoundboardStore.getState().sounds.map((s) => s.id);

beforeEach(() => {
  vi.clearAllMocks();
  useVoiceMessageStore.setState({ messagesByChannel: { vc1: [vmsg("m1")] } });
  useSoundboardStore.setState({ sounds: [sound("s-a")] });
});

describe("voice chat without the socket", () => {
  it("should show the sent message with no WS event", async () => {
    voiceApi.sendVoiceMessage.mockResolvedValue(ok(vmsg("m2", "hello")));

    expect(await useVoiceMessageStore.getState().send("vc1", "hello")).toBe(true);

    expect(voiceIds()).toEqual(["m1", "m2"]);
  });

  it("should show the edit with no WS event", async () => {
    voiceApi.editVoiceMessage.mockResolvedValue(ok(vmsg("m1", "edited")));

    expect(await useVoiceMessageStore.getState().edit("vc1", "m1", "edited")).toBe(true);

    expect(useVoiceMessageStore.getState().messagesByChannel["vc1"][0].content).toBe("edited");
  });

  it("should remove the deleted message with no WS event", async () => {
    voiceApi.deleteVoiceMessage.mockResolvedValue({ success: true as const, data: undefined });

    expect(await useVoiceMessageStore.getState().del("vc1", "m1")).toBe(true);

    expect(voiceIds()).toEqual([]);
  });

  it("should not show a message the server refused", async () => {
    voiceApi.sendVoiceMessage.mockResolvedValue(fail("too long"));

    expect(await useVoiceMessageStore.getState().send("vc1", "hello")).toBe(false);

    expect(voiceIds()).toEqual(["m1"]);
  });

  it("should keep the original text when the edit is refused", async () => {
    voiceApi.editVoiceMessage.mockResolvedValue(fail());

    expect(await useVoiceMessageStore.getState().edit("vc1", "m1", "edited")).toBe(false);

    expect(useVoiceMessageStore.getState().messagesByChannel["vc1"][0].content).toBe("m1");
  });

  it("should keep the message when the delete is refused", async () => {
    voiceApi.deleteVoiceMessage.mockResolvedValue(fail());

    expect(await useVoiceMessageStore.getState().del("vc1", "m1")).toBe(false);

    expect(voiceIds()).toEqual(["m1"]);
  });
});

describe("the echo replaying a local voice-chat mutation", () => {
  it("should not show the sent message twice", async () => {
    const sent = vmsg("m2", "hello");
    voiceApi.sendVoiceMessage.mockResolvedValue(ok(sent));
    await useVoiceMessageStore.getState().send("vc1", "hello");

    useVoiceMessageStore.getState().append(sent);

    expect(voiceIds()).toEqual(["m1", "m2"]);
  });

  it("should leave a deleted message deleted", async () => {
    voiceApi.deleteVoiceMessage.mockResolvedValue({ success: true as const, data: undefined });
    await useVoiceMessageStore.getState().del("vc1", "m1");

    useVoiceMessageStore.getState().remove("vc1", "m1");

    expect(voiceIds()).toEqual([]);
  });
});

describe("the soundboard without the socket", () => {
  it("should list an uploaded sound with no WS event", async () => {
    soundApi.createSound.mockResolvedValue(ok(sound("s-b")));

    const res = await useSoundboardStore
      .getState()
      .createSound("s1", new File([""], "s.mp3"), "s-b", 1000);

    expect(res.ok).toBe(true);
    expect(soundIds()).toEqual(["s-a", "s-b"]);
  });

  it("should remove a deleted sound with no WS event", async () => {
    soundApi.deleteSound.mockResolvedValue({ success: true as const, data: undefined });

    expect(await useSoundboardStore.getState().deleteSound("s1", "s-a")).toBe(true);

    expect(soundIds()).toEqual([]);
  });

  it("should pass the upload's refusal back to the form", async () => {
    soundApi.createSound.mockResolvedValue(fail("file too large"));

    const res = await useSoundboardStore
      .getState()
      .createSound("s1", new File([""], "s.mp3"), "s-b", 1000);

    expect(res.ok).toBe(false);
    // The form prints this inline; a generic string hides which rule was hit.
    expect(res.error).toBe("file too large");
    expect(soundIds()).toEqual(["s-a"]);
  });

  it("should keep a sound the server refused to delete", async () => {
    soundApi.deleteSound.mockResolvedValue(fail());

    expect(await useSoundboardStore.getState().deleteSound("s1", "s-a")).toBe(false);

    expect(soundIds()).toEqual(["s-a"]);
  });

  // handleSoundCreate appended unconditionally until this slice.
  it("should not list an uploaded sound twice when the echo arrives", async () => {
    const created = sound("s-b");
    soundApi.createSound.mockResolvedValue(ok(created));
    await useSoundboardStore.getState().createSound("s1", new File([""], "s.mp3"), "s-b", 1000);

    useSoundboardStore.getState().handleSoundCreate(created);

    expect(soundIds()).toEqual(["s-a", "s-b"]);
  });

  it("should leave a deleted sound deleted", async () => {
    soundApi.deleteSound.mockResolvedValue({ success: true as const, data: undefined });
    await useSoundboardStore.getState().deleteSound("s1", "s-a");

    useSoundboardStore.getState().handleSoundDelete({ id: "s-a", server_id: "s1" });

    expect(soundIds()).toEqual([]);
  });
});
