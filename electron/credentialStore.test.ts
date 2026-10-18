import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCredentialStore, type SafeStorageLike } from "./credentialStore";

// A reversible stand-in for safeStorage: "enc:" + base64. Behaviour toggles model the failures.
function fakeCrypto() {
  const state = {
    available: true,
    asyncDecryptFails: false,
    syncDecryptFails: false,
    shouldReEncrypt: false,
    encryptCalls: 0,
  };
  const crypto: SafeStorageLike = {
    isAsyncEncryptionAvailable: async () => state.available,
    encryptStringAsync: async (text) => {
      state.encryptCalls++;
      return Buffer.from("enc:" + Buffer.from(text).toString("base64"));
    },
    decryptStringAsync: async (buf) => {
      const s = buf.toString();
      if (state.asyncDecryptFails || !s.startsWith("enc:")) throw new Error("Error while decrypting the ciphertext");
      return { result: Buffer.from(s.slice(4), "base64").toString(), shouldReEncrypt: state.shouldReEncrypt };
    },
    decryptString: (buf) => {
      const s = buf.toString();
      if (state.syncDecryptFails || !s.startsWith("old:")) throw new Error("sync decrypt failed");
      return Buffer.from(s.slice(4), "base64").toString();
    },
  };
  return { crypto, state };
}

const creds = { username: "alice", password: "correct horse" };
let path: string;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "credstore-")), "cred.enc");
});

function store(crypto: SafeStorageLike) {
  return createCredentialStore(path, crypto, () => ({ platform: "windows", backend: "" }));
}

describe("credential store", () => {
  it("should read back what it saved", async () => {
    const { crypto } = fakeCrypto();
    const s = store(crypto);

    expect(await s.save(creds)).toEqual({ ok: true });
    expect(await s.load()).toEqual({ credentials: creds });
  });

  it("should load nothing, and report nothing, when nothing was saved", async () => {
    const { crypto } = fakeCrypto();

    expect(await store(crypto).load()).toEqual({ credentials: null });
  });

  it("should say why when encryption is unavailable instead of pretending to save", async () => {
    const { crypto, state } = fakeCrypto();
    state.available = false;

    const res = await store(crypto).save(creds);

    expect(res).toMatchObject({ ok: false, failure: { reason: "unavailable", platform: "windows" } });
    expect(existsSync(path)).toBe(false);
  });

  it("should report an unreadable file and remove it so the next save starts clean", async () => {
    const { crypto, state } = fakeCrypto();
    const s = store(crypto);
    await s.save(creds);
    state.asyncDecryptFails = true;
    state.syncDecryptFails = true;

    const res = await s.load();

    expect(res.credentials).toBeNull();
    expect(res.failure).toMatchObject({ reason: "decrypt_failed", detail: "Error while decrypting the ciphertext" });
    expect(existsSync(path)).toBe(false);
  });

  it("should read a file written by the old sync API and re-save it with the async one", async () => {
    const { crypto, state } = fakeCrypto();
    writeFileSync(path, "old:" + Buffer.from(JSON.stringify(creds)).toString("base64"));

    const res = await store(crypto).load();

    expect(res).toEqual({ credentials: creds });
    expect(state.encryptCalls).toBe(1);
    expect(readFileSync(path).toString().startsWith("enc:")).toBe(true);
  });

  it("should re-encrypt when safeStorage says the key rotated", async () => {
    const { crypto, state } = fakeCrypto();
    const s = store(crypto);
    await s.save(creds);
    state.shouldReEncrypt = true;
    state.encryptCalls = 0;

    await s.load();

    expect(state.encryptCalls).toBe(1);
  });

  it("should reject content that is not a username and password", async () => {
    const { crypto } = fakeCrypto();
    writeFileSync(path, "enc:" + Buffer.from(JSON.stringify({ token: "x" })).toString("base64"));

    const res = await store(crypto).load();

    expect(res.credentials).toBeNull();
    expect(res.failure?.reason).toBe("decrypt_failed");
  });

  it("should forget the saved credentials on clear, and not fail when there are none", async () => {
    const { crypto } = fakeCrypto();
    const s = store(crypto);
    await s.save(creds);

    await s.clear();
    await s.clear();

    expect(existsSync(path)).toBe(false);
  });
});
