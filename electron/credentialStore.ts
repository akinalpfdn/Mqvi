/**
 * "Remember me" storage: the username and password, encrypted with Electron's safeStorage, in one
 * file. Every failure is returned rather than swallowed — the renderer reports it to the server,
 * since otherwise the only symptom is an empty login form.
 */

import { existsSync } from "fs";
import { readFile, writeFile, rename, unlink } from "fs/promises";

export type StoredCredentials = { username: string; password: string };

export type CredentialFailure = {
  reason: "unavailable" | "encrypt_failed" | "write_failed" | "decrypt_failed" | "read_failed";
  detail: string;
  platform: "windows" | "macos" | "linux";
  backend: string;
};

/** The slice of Electron's safeStorage this needs. */
export type SafeStorageLike = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  decryptString(encrypted: Buffer): string;
};

export type SaveResult = { ok: true } | { ok: false; failure: CredentialFailure };
export type LoadResult = { credentials: StoredCredentials | null; failure?: CredentialFailure };

function isStoredCredentials(v: unknown): v is StoredCredentials {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as StoredCredentials).username === "string" &&
    typeof (v as StoredCredentials).password === "string"
  );
}

export function createCredentialStore(
  path: string,
  crypto: SafeStorageLike,
  describe: () => Pick<CredentialFailure, "platform" | "backend">
) {
  const failure = (reason: CredentialFailure["reason"], err?: unknown): CredentialFailure => ({
    reason,
    detail: err instanceof Error ? err.message : err === undefined ? "" : String(err),
    ...describe(),
  });

  // An unreadable file would fail the same way on every start; removing it lets the next
  // "remember me" save a fresh copy.
  const discard = () => unlink(path).catch(() => {});

  async function save(creds: StoredCredentials): Promise<SaveResult> {
    if (!(await crypto.isAsyncEncryptionAvailable())) {
      return { ok: false, failure: failure("unavailable") };
    }
    let encrypted: Buffer;
    try {
      encrypted = await crypto.encryptStringAsync(JSON.stringify(creds));
    } catch (err) {
      return { ok: false, failure: failure("encrypt_failed", err) };
    }
    // Write-then-rename: a crash mid-write must not leave a truncated file that later fails to
    // decrypt and costs the saved login.
    const tmp = `${path}.tmp`;
    try {
      await writeFile(tmp, encrypted);
      await rename(tmp, path);
    } catch (err) {
      return { ok: false, failure: failure("write_failed", err) };
    }
    return { ok: true };
  }

  async function load(): Promise<LoadResult> {
    if (!existsSync(path)) return { credentials: null };

    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch (err) {
      return { credentials: null, failure: failure("read_failed", err) };
    }

    // The async API supports key rotation; files from before it were written with the sync one.
    let text: string;
    let reEncrypt: boolean;
    try {
      const res = await crypto.decryptStringAsync(raw);
      text = res.result;
      reEncrypt = res.shouldReEncrypt;
    } catch (asyncErr) {
      try {
        text = crypto.decryptString(raw);
        reEncrypt = true;
      } catch {
        await discard();
        return { credentials: null, failure: failure("decrypt_failed", asyncErr) };
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      await discard();
      return { credentials: null, failure: failure("decrypt_failed", err) };
    }
    if (!isStoredCredentials(parsed)) {
      await discard();
      return { credentials: null, failure: failure("decrypt_failed", "unexpected content") };
    }

    if (reEncrypt) {
      const saved = await save(parsed);
      if (!saved.ok) return { credentials: parsed, failure: saved.failure };
    }
    return { credentials: parsed };
  }

  // Missing already is the goal state.
  const clear = () => discard();

  return { save, load, clear };
}
