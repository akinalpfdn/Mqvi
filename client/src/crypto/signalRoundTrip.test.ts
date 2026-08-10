/**
 * Two-party Signal round-trip: does a message Alice encrypts actually come back as itself on Bob's
 * device, and does the ratchet keep working once they take turns?
 *
 * The existing protocol test (ratchetConcurrency) fabricates a SessionState and exercises locking.
 * Nothing has ever run the key agreement itself — X3DH from both sides, the prekey message, the
 * first ratchet turn. That is the part where a bug means every encrypted message in the product is
 * unreadable, and it fails closed and silently: the recipient just sees a message they cannot open.
 *
 * Both parties run the real protocol code. keyStorage is mocked as two independent in-memory
 * devices, and `as(party, ...)` decides which one the module is talking to for the duration of a
 * call — the calls here are sequential, so a pointer is enough.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { must } from "../test/must";

type Device = {
  identity: { publicKey: Uint8Array; privateKey: Uint8Array };
  signing: { publicKey: Uint8Array; privateKey: Uint8Array };
  registration: { registrationId: number; deviceId: string; userId: string };
  signedPreKeys: Map<number, { id: number; publicKey: Uint8Array; privateKey: Uint8Array; signature: Uint8Array; createdAt: number }>;
  preKeys: Map<number, { id: number; publicKey: Uint8Array; privateKey: Uint8Array }>;
  sessions: Map<string, unknown>;
  /** Load-bearing, not incidental: the pending X3DH info a first message carries is stashed here
   *  between establishing the session and encrypting, so a metadata stub that returns null turns
   *  every first message into an ordinary one the recipient cannot open. */
  metadata: Map<string, unknown>;
};

let current: Device;

function clone<T>(v: T): T {
  return structuredClone(v);
}

vi.mock("./keyStorage", () => ({
  getIdentityKeyPair: vi.fn(async () => current.identity),
  getSigningKeyPair: vi.fn(async () => current.signing),
  getRegistrationData: vi.fn(async () => current.registration),
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
}));

const { establishAndEncrypt, encryptMessage, decryptMessage, processPreKeyMessage, toBase64 } =
  await import("./signalProtocol");
import type { SignalWireMessage, StoredSession } from "./types";

const ALICE = { userId: "alice", deviceId: "alice-1" };
const BOB = { userId: "bob", deviceId: "bob-1" };

function newDevice(userId: string, deviceId: string, registrationId: number): Device {
  const idPriv = x25519.utils.randomSecretKey();
  const signPriv = ed25519.utils.randomSecretKey();
  const spkPriv = x25519.utils.randomSecretKey();
  const spkPub = x25519.getPublicKey(spkPriv);
  const otpPriv = x25519.utils.randomSecretKey();

  return {
    identity: { privateKey: idPriv, publicKey: x25519.getPublicKey(idPriv) },
    signing: { privateKey: signPriv, publicKey: ed25519.getPublicKey(signPriv) },
    registration: { registrationId, deviceId, userId },
    signedPreKeys: new Map([
      [1, { id: 1, publicKey: spkPub, privateKey: spkPriv, signature: ed25519.sign(spkPub, signPriv), createdAt: 0 }],
    ]),
    preKeys: new Map([[100, { id: 100, publicKey: x25519.getPublicKey(otpPriv), privateKey: otpPriv }]]),
    sessions: new Map(),
    metadata: new Map(),
  };
}

/** Run fn as the given device. */
async function as<T>(d: Device, fn: () => Promise<T>): Promise<T> {
  current = d;
  return fn();
}

/** The bundle a device publishes for others to start a session with. */
function bundleOf(d: Device, withOneTime = true) {
  const spk = must(d.signedPreKeys.get(1), "signed prekey 1");
  const otp = must(d.preKeys.get(100), "one-time prekey 100");
  return {
    registrationId: d.registration.registrationId,
    identityKey: toBase64(d.identity.publicKey),
    signingKey: toBase64(d.signing.publicKey),
    signedPrekeyId: spk.id,
    signedPrekey: toBase64(spk.publicKey),
    signedPrekeySignature: toBase64(spk.signature),
    ...(withOneTime ? { oneTimePrekeyId: otp.id, oneTimePrekey: toBase64(otp.publicKey) } : {}),
  };
}

/** Bob receives a prekey message from Alice: complete X3DH, store the session, then decrypt. */
async function bobReceivesFirst(bob: Device, wire: SignalWireMessage): Promise<string> {
  return as(bob, async () => {
    // preKeyInfo is what makes it a first message; without it there is nothing to complete X3DH
    // from and the test is not testing what it says it is.
    const state = await processPreKeyMessage(
      ALICE.userId,
      ALICE.deviceId,
      must(wire.preKeyInfo, "preKeyInfo on the first message")
    );
    const session: StoredSession = {
      userId: ALICE.userId,
      deviceId: ALICE.deviceId,
      state,
      createdAt: 0,
      updatedAt: 0,
    };
    bob.sessions.set(`${ALICE.userId}:${ALICE.deviceId}`, clone(session));
    return decryptMessage(ALICE.userId, ALICE.deviceId, wire);
  });
}

let alice: Device;
let bob: Device;

beforeEach(() => {
  alice = newDevice(ALICE.userId, ALICE.deviceId, 1111);
  bob = newDevice(BOB.userId, BOB.deviceId, 2222);
});

describe("Signal round-trip", () => {
  it("should deliver the first message as itself", async () => {
    const plaintext = "the first message, which nobody has ever decrypted in a test";

    const wire = await as(alice, () =>
      establishAndEncrypt(BOB.userId, BOB.deviceId, bundleOf(bob), plaintext)
    );

    expect(await bobReceivesFirst(bob, wire)).toBe(plaintext);
  });

  it("should keep working when they take turns", async () => {
    const first = await as(alice, () =>
      establishAndEncrypt(BOB.userId, BOB.deviceId, bundleOf(bob), "hello")
    );
    expect(await bobReceivesFirst(bob, first)).toBe("hello");

    // Bob's reply turns the ratchet: a new sending chain on his side that Alice has never seen.
    const reply = await as(bob, () => encryptMessage(ALICE.userId, ALICE.deviceId, "hello back"));
    expect(await as(alice, () => decryptMessage(BOB.userId, BOB.deviceId, reply))).toBe("hello back");

    // And back again, which turns it a second time.
    const third = await as(alice, () => encryptMessage(BOB.userId, BOB.deviceId, "still here"));
    expect(await as(bob, () => decryptMessage(ALICE.userId, ALICE.deviceId, third))).toBe("still here");
  });

  it("should deliver a run of messages in one chain", async () => {
    const first = await as(alice, () =>
      establishAndEncrypt(BOB.userId, BOB.deviceId, bundleOf(bob), "m0")
    );
    expect(await bobReceivesFirst(bob, first)).toBe("m0");

    for (let i = 1; i <= 5; i++) {
      const wire = await as(alice, () => encryptMessage(BOB.userId, BOB.deviceId, `m${i}`));
      expect(await as(bob, () => decryptMessage(ALICE.userId, ALICE.deviceId, wire))).toBe(`m${i}`);
    }
  });

  // The network reorders. A ratchet that only accepts messages in order would drop the ones that
  // overtook — silently, since a failed decrypt is indistinguishable from a message never sent.
  it("should decrypt messages that arrive out of order", async () => {
    const first = await as(alice, () =>
      establishAndEncrypt(BOB.userId, BOB.deviceId, bundleOf(bob), "m0")
    );
    expect(await bobReceivesFirst(bob, first)).toBe("m0");

    const m1 = await as(alice, () => encryptMessage(BOB.userId, BOB.deviceId, "m1"));
    const m2 = await as(alice, () => encryptMessage(BOB.userId, BOB.deviceId, "m2"));
    const m3 = await as(alice, () => encryptMessage(BOB.userId, BOB.deviceId, "m3"));

    // m3 overtakes; m1 and m2 arrive afterwards.
    expect(await as(bob, () => decryptMessage(ALICE.userId, ALICE.deviceId, m3))).toBe("m3");
    expect(await as(bob, () => decryptMessage(ALICE.userId, ALICE.deviceId, m1))).toBe("m1");
    expect(await as(bob, () => decryptMessage(ALICE.userId, ALICE.deviceId, m2))).toBe("m2");
  });

  it("should produce a different ciphertext for the same plaintext twice", async () => {
    const a = await as(alice, () =>
      establishAndEncrypt(BOB.userId, BOB.deviceId, bundleOf(bob), "same words")
    );
    const b = await as(alice, () => encryptMessage(BOB.userId, BOB.deviceId, "same words"));

    // The chain must advance per message. Identical ciphertext would mean a reused message key,
    // which lets anyone watching the wire see that two messages are the same.
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("should refuse a message whose ciphertext was altered", async () => {
    const first = await as(alice, () =>
      establishAndEncrypt(BOB.userId, BOB.deviceId, bundleOf(bob), "m0")
    );
    expect(await bobReceivesFirst(bob, first)).toBe("m0");

    const wire = await as(alice, () => encryptMessage(BOB.userId, BOB.deviceId, "genuine"));
    const raw = atob(wire.ciphertext);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = { ...wire, ciphertext: btoa(String.fromCharCode(...bytes)) };

    await expect(
      as(bob, () => decryptMessage(ALICE.userId, ALICE.deviceId, tampered))
    ).rejects.toThrow();
  });

  // A bundle with no one-time prekey is the normal state for a device that has been offline long
  // enough to exhaust its uploaded batch. X3DH is specified to work without it, with weaker
  // forward secrecy — but it must still work, or that user becomes unmessageable.
  it("should establish a session when the bundle has no one-time prekey", async () => {
    const wire = await as(alice, () =>
      establishAndEncrypt(BOB.userId, BOB.deviceId, bundleOf(bob, false), "no otp available")
    );

    expect(await bobReceivesFirst(bob, wire)).toBe("no otp available");
  });
});
