/**
 * Round-trip fidelity for the E2EE key backup.
 *
 * This is the one crypto path where a bug costs the user everything rather than one message: the
 * backup is what carries their identity, sessions and decrypted history onto a new device. A
 * category that is collected but not restored, or a value mangled through base64, is invisible
 * until someone actually migrates — and by then the old device may be gone.
 *
 * Drives the real keyBackup code against an in-memory stand-in for IndexedDB, the same approach
 * ratchetConcurrency.test.ts uses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Store = {
  identity: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
  signing: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
  registration: { registrationId: number; deviceId: string; userId: string } | null;
  signedPreKeys: unknown[];
  preKeys: unknown[];
  sessions: unknown[];
  senderKeys: unknown[];
  trustedIdentities: unknown[];
  cachedMessages: unknown[];
  metadata: Map<string, unknown>;
};

const store: Store = emptyStore();

function emptyStore(): Store {
  return {
    identity: null,
    signing: null,
    registration: null,
    signedPreKeys: [],
    preKeys: [],
    sessions: [],
    senderKeys: [],
    trustedIdentities: [],
    cachedMessages: [],
    metadata: new Map(),
  };
}

vi.mock("./keyStorage", () => ({
  getIdentityKeyPair: vi.fn(async () => store.identity),
  saveIdentityKeyPair: vi.fn(async (v: Store["identity"]) => { store.identity = v; }),
  getSigningKeyPair: vi.fn(async () => store.signing),
  saveSigningKeyPair: vi.fn(async (v: Store["signing"]) => { store.signing = v; }),
  getRegistrationData: vi.fn(async () => store.registration),
  saveRegistrationData: vi.fn(async (v: Store["registration"]) => { store.registration = v; }),
  getAllSignedPreKeys: vi.fn(async () => store.signedPreKeys),
  saveSignedPreKey: vi.fn(async (v: unknown) => { store.signedPreKeys.push(v); }),
  getAllPreKeys: vi.fn(async () => store.preKeys),
  savePreKeys: vi.fn(async (v: unknown[]) => { store.preKeys.push(...v); }),
  getAllSessions: vi.fn(async () => store.sessions),
  saveSession: vi.fn(async (v: unknown) => { store.sessions.push(v); }),
  getAllSenderKeys: vi.fn(async () => store.senderKeys),
  saveSenderKey: vi.fn(async (v: unknown) => { store.senderKeys.push(v); }),
  getAllTrustedIdentities: vi.fn(async () => store.trustedIdentities),
  saveTrustedIdentity: vi.fn(async (...args: unknown[]) => { store.trustedIdentities.push(args); }),
  getAllCachedMessages: vi.fn(async () => store.cachedMessages),
  cacheDecryptedMessages: vi.fn(async (v: unknown[]) => { store.cachedMessages.push(...v); }),
  cacheDecryptedMessage: vi.fn(async (v: unknown) => { store.cachedMessages.push(v); }),
  getMetadata: vi.fn(async (k: string) => store.metadata.get(k) ?? null),
  setMetadata: vi.fn(async (k: string, v: unknown) => { store.metadata.set(k, v); }),
  clearAllE2EEData: vi.fn(async () => {
    const fresh = emptyStore();
    Object.assign(store, fresh);
  }),
}));

const { createBackup, restoreFromBackup } = await import("./keyBackup");

/** Distinguishable bytes, so a value landing in the wrong field is visible rather than plausible. */
function bytes(seed: number, len = 32): Uint8Array {
  return Uint8Array.from({ length: len }, (_, i) => (seed * 31 + i) % 256);
}

/**
 * Compare by content, not by object identity. Under jsdom a Uint8Array built inside the module and
 * one built by the test come from different realms, so toEqual reports them unequal while printing
 * "no visual difference" — a false failure that says nothing about the bytes.
 */
function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v))
  );
}

function seedEverything(): void {
  store.identity = { publicKey: bytes(1), privateKey: bytes(2) };
  store.signing = { publicKey: bytes(3), privateKey: bytes(4) };
  store.registration = { registrationId: 4242, deviceId: "device-1", userId: "user-1" };
  store.signedPreKeys = [
    { id: 7, publicKey: bytes(5), privateKey: bytes(6), signature: bytes(7, 64), createdAt: 1111 },
  ];
  store.preKeys = [{ id: 11, publicKey: bytes(8), privateKey: bytes(9) }];
  store.metadata.set("nextPrekeyId", 99);
}

beforeEach(() => {
  Object.assign(store, emptyStore());
});

describe("key backup", () => {
  it("should restore every field exactly as it was backed up", async () => {
    seedEverything();
    const before = plain(store);

    const backup = await createBackup("correct horse battery staple");

    // The new device: nothing local at all.
    Object.assign(store, emptyStore());

    const ok = await restoreFromBackup(backup, "correct horse battery staple");
    expect(ok).toBe(true);

    expect(plain(store.identity)).toEqual((before as Record<string, unknown>).identity);
    expect(plain(store.signing)).toEqual((before as Record<string, unknown>).signing);
    // The three fields the backup carries. `createdAt` is deliberately not among them — restore
    // stamps it fresh, since this device's registration begins now, and nothing reads it.
    expect(store.registration).toMatchObject({
      registrationId: 4242,
      deviceId: "device-1",
      userId: "user-1",
    });
    expect(plain(store.signedPreKeys)).toEqual((before as Record<string, unknown>).signedPreKeys);
    expect(plain(store.preKeys)).toEqual((before as Record<string, unknown>).preKeys);
    expect(store.metadata.get("nextPrekeyId")).toBe(99);
  });

  it("should refuse a wrong password without destroying the keys already on the device", async () => {
    seedEverything();
    const backup = await createBackup("the real password");
    const before = plain(store);

    const ok = await restoreFromBackup(backup, "not the real password");

    expect(ok).toBe(false);
    // AES-GCM is authenticated, so the wrong key fails before anything is written. If this ever
    // regresses, a mistyped password wipes the device it was typed on.
    expect(plain(store.identity)).toEqual((before as Record<string, unknown>).identity);
    expect(plain(store.registration)).toEqual((before as Record<string, unknown>).registration);
  });

  it("should refuse a tampered payload", async () => {
    seedEverything();
    const backup = await createBackup("pw");

    // Flip one byte of ciphertext. GCM's tag must catch it.
    const raw = atob(backup.encryptedData);
    const tampered = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    tampered[0] ^= 0xff;
    const corrupt = { ...backup, encryptedData: btoa(String.fromCharCode(...tampered)) };

    expect(await restoreFromBackup(corrupt, "pw")).toBe(false);
  });

  it("should produce a different ciphertext each time for the same input", async () => {
    seedEverything();

    const a = await createBackup("pw");
    const b = await createBackup("pw");

    // Fresh salt and nonce per backup. Reusing either would leak that two backups are identical,
    // and a repeated GCM nonce under one key is a break, not a smell.
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.encryptedData).not.toBe(b.encryptedData);
  });

  it("should refuse to back up a device that has no keys", async () => {
    // Backing up an uninitialised device would write an empty backup over a good one.
    await expect(createBackup("pw")).rejects.toThrow();
  });
});
