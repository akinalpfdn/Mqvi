/**
 * Multi-device fan-out for DMs.
 *
 * A DM is not encrypted once. It is encrypted separately for every device the recipient owns, plus
 * every device the sender owns except the one doing the sending — that last part is what puts a
 * sent message in your own phone's copy of the conversation.
 *
 * The failure is per-device and silent: one device is skipped, and only that device never sees the
 * message. Nobody else can tell, and the person on it just thinks the message was never sent. The
 * mirror failure is the sending device encrypting to itself, which wastes a session and can leave
 * it decrypting its own message into the thread twice.
 *
 * Real protocol code throughout; keyStorage and the bundle API are the only stand-ins.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";

type Device = {
  userId: string;
  deviceId: string;
  registrationId: number;
  identity: { publicKey: Uint8Array; privateKey: Uint8Array };
  signing: { publicKey: Uint8Array; privateKey: Uint8Array };
  signedPreKeys: Map<number, { id: number; publicKey: Uint8Array; privateKey: Uint8Array; signature: Uint8Array; createdAt: number }>;
  preKeys: Map<number, { id: number; publicKey: Uint8Array; privateKey: Uint8Array }>;
  sessions: Map<string, unknown>;
  metadata: Map<string, unknown>;
};

let current: Device;
/** Every device in the world, by user. What fetchPreKeyBundles answers from. */
const world = new Map<string, Device[]>();

function clone<T>(v: T): T {
  return structuredClone(v);
}

vi.mock("./keyStorage", () => ({
  getIdentityKeyPair: vi.fn(async () => current.identity),
  getSigningKeyPair: vi.fn(async () => current.signing),
  getRegistrationData: vi.fn(async () => ({
    registrationId: current.registrationId,
    deviceId: current.deviceId,
    userId: current.userId,
  })),
  getSignedPreKey: vi.fn(async (id: number) => current.signedPreKeys.get(id) ?? null),
  getPreKey: vi.fn(async (id: number) => current.preKeys.get(id) ?? null),
  deletePreKey: vi.fn(async (id: number) => { current.preKeys.delete(id); }),
  hasSession: vi.fn(async (u: string, d: string) => current.sessions.has(`${u}:${d}`)),
  getSession: vi.fn(async (u: string, d: string) => {
    const s = current.sessions.get(`${u}:${d}`);
    return s ? clone(s) : null;
  }),
  saveSession: vi.fn(async (s: { userId: string; deviceId: string }) => {
    current.sessions.set(`${s.userId}:${s.deviceId}`, clone(s));
  }),
  deleteSession: vi.fn(async (u: string, d: string) => { current.sessions.delete(`${u}:${d}`); }),
  getTrustedIdentity: vi.fn(async () => null),
  saveTrustedIdentity: vi.fn(async () => {}),
  getMetadata: vi.fn(async (k: string) => current.metadata.get(k) ?? null),
  setMetadata: vi.fn(async (k: string, v: unknown) => { current.metadata.set(k, v); }),
  deleteMetadata: vi.fn(async (k: string) => { current.metadata.delete(k); }),
  cacheDecryptedMessage: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
}));

vi.mock("../api/e2ee", () => ({
  fetchPreKeyBundles: vi.fn(async (userId: string) => ({
    success: true,
    data: (world.get(userId) ?? []).map(bundleFor),
  })),
}));

const { encryptDMMessage } = await import("./dmEncryption");
const { processPreKeyMessage, decryptMessage, toBase64 } = await import("./signalProtocol");
import type { StoredSession } from "./types";

let nextRegistration = 1000;

function newDevice(userId: string, deviceId: string): Device {
  const idPriv = x25519.utils.randomSecretKey();
  const signPriv = ed25519.utils.randomSecretKey();
  const spkPriv = x25519.utils.randomSecretKey();
  const spkPub = x25519.getPublicKey(spkPriv);
  const otpPriv = x25519.utils.randomSecretKey();

  const d: Device = {
    userId,
    deviceId,
    registrationId: nextRegistration++,
    identity: { privateKey: idPriv, publicKey: x25519.getPublicKey(idPriv) },
    signing: { privateKey: signPriv, publicKey: ed25519.getPublicKey(signPriv) },
    signedPreKeys: new Map([
      [1, { id: 1, publicKey: spkPub, privateKey: spkPriv, signature: ed25519.sign(spkPub, signPriv), createdAt: 0 }],
    ]),
    preKeys: new Map([[100, { id: 100, publicKey: x25519.getPublicKey(otpPriv), privateKey: otpPriv }]]),
    sessions: new Map(),
    metadata: new Map(),
  };

  world.set(userId, [...(world.get(userId) ?? []), d]);
  return d;
}

/** The server's view of a device: its published prekey bundle. */
function bundleFor(d: Device) {
  const spk = d.signedPreKeys.get(1)!;
  const otp = d.preKeys.get(100)!;
  return {
    device_id: d.deviceId,
    registration_id: d.registrationId,
    identity_key: toBase64(d.identity.publicKey),
    signing_key: toBase64(d.signing.publicKey),
    signed_prekey_id: spk.id,
    signed_prekey: toBase64(spk.publicKey),
    signed_prekey_signature: toBase64(spk.signature),
    one_time_prekey_id: otp.id,
    one_time_prekey: toBase64(otp.publicKey),
  };
}

async function as<T>(d: Device, fn: () => Promise<T>): Promise<T> {
  current = d;
  return fn();
}

/** Open an envelope on the device it was addressed to. */
async function openOn(
  target: Device,
  senderUserId: string,
  senderDeviceId: string,
  envelope: { message_type: number; ciphertext: string; recipient_device_id?: string }
): Promise<string> {
  // The envelope's `ciphertext` is the whole SignalWireMessage as JSON — header, ciphertext and
  // preKeyInfo — not a base64 blob. Only the inner `ciphertext` field is base64.
  const wire = JSON.parse(envelope.ciphertext);
  return as(target, async () => {
    if (wire.preKeyInfo) {
      const state = await processPreKeyMessage(senderUserId, senderDeviceId, wire.preKeyInfo);
      const session: StoredSession = {
        userId: senderUserId,
        deviceId: senderDeviceId,
        state,
        createdAt: 0,
        updatedAt: 0,
      };
      target.sessions.set(`${senderUserId}:${senderDeviceId}`, clone(session));
    }
    return decryptMessage(senderUserId, senderDeviceId, wire);
  });
}

let alicePhone: Device;
let aliceLaptop: Device;
let bobPhone: Device;
let bobTablet: Device;

beforeEach(() => {
  world.clear();
  nextRegistration = 1000;
  alicePhone = newDevice("alice", "alice-phone");
  aliceLaptop = newDevice("alice", "alice-laptop");
  bobPhone = newDevice("bob", "bob-phone");
  bobTablet = newDevice("bob", "bob-tablet");
});

describe("multi-device DM fan-out", () => {
  it("should address every recipient device and every other device of the sender", async () => {
    const envelopes = await as(alicePhone, () =>
      encryptDMMessage("alice", "bob", "alice-phone", "hello")
    );

    const addressed = envelopes.map((e) => e.recipient_device_id).sort();
    expect(addressed).toEqual(["alice-laptop", "bob-phone", "bob-tablet"]);
  });

  it("should not address the device doing the sending", async () => {
    const envelopes = await as(alicePhone, () =>
      encryptDMMessage("alice", "bob", "alice-phone", "hello")
    );

    // Encrypting to itself wastes a session and can put the message in the thread twice.
    expect(envelopes.map((e) => e.recipient_device_id)).not.toContain("alice-phone");
    expect(envelopes.every((e) => e.sender_device_id === "alice-phone")).toBe(true);
  });

  it("should produce an envelope each addressed device can actually open", async () => {
    const envelopes = await as(alicePhone, () =>
      encryptDMMessage("alice", "bob", "alice-phone", "the same words to everyone")
    );

    const byDevice = new Map(envelopes.map((e) => [e.recipient_device_id, e]));
    for (const target of [aliceLaptop, bobPhone, bobTablet]) {
      const envelope = byDevice.get(target.deviceId);
      expect(envelope, `no envelope for ${target.deviceId}`).toBeDefined();
      expect(await openOn(target, "alice", "alice-phone", envelope!)).toBe(
        "the same words to everyone"
      );
    }
  });

  it("should give each device its own ciphertext", async () => {
    const envelopes = await as(alicePhone, () =>
      encryptDMMessage("alice", "bob", "alice-phone", "same words")
    );

    // One shared ciphertext would mean one shared key across devices — losing one device would
    // then expose every other device's traffic.
    const ciphertexts = new Set(envelopes.map((e) => e.ciphertext));
    expect(ciphertexts.size).toBe(envelopes.length);
  });

  it("should reach a device the recipient added after the conversation started", async () => {
    await as(alicePhone, () => encryptDMMessage("alice", "bob", "alice-phone", "first"));

    const bobDesktop = newDevice("bob", "bob-desktop");
    const envelopes = await as(alicePhone, () =>
      encryptDMMessage("alice", "bob", "alice-phone", "second")
    );

    expect(envelopes.map((e) => e.recipient_device_id)).toContain("bob-desktop");
    const forDesktop = envelopes.find((e) => e.recipient_device_id === "bob-desktop")!;
    expect(await openOn(bobDesktop, "alice", "alice-phone", forDesktop)).toBe("second");
  });

  it("should still send when the sender has no other devices", async () => {
    world.set("alice", [alicePhone]);

    const envelopes = await as(alicePhone, () =>
      encryptDMMessage("alice", "bob", "alice-phone", "solo")
    );

    expect(envelopes.map((e) => e.recipient_device_id).sort()).toEqual(["bob-phone", "bob-tablet"]);
  });

  it("should refuse to send to someone who has not set up E2EE", async () => {
    world.set("bob", []);

    await expect(
      as(alicePhone, () => encryptDMMessage("alice", "bob", "alice-phone", "nobody home"))
    ).rejects.toThrow("RECIPIENT_NO_KEYS");
  });
});
