/**
 * Gets "remember me" failures to the server without the user doing anything. A read fails on the
 * login screen, before there is a session to report with, so failures wait here until one exists.
 */

import { reportCredentialStoreFailure } from "../api/auth";
import { isTransientStatus } from "../api/client";
import type { CredentialStoreFailure } from "../types/electron";

const PENDING_KEY = "mqvi_pending_credential_failures";
/** A device stuck failing would otherwise grow this on every launch. */
const MAX_PENDING = 5;

type PendingFailure = { operation: "save" | "load"; failure: CredentialStoreFailure };

function readPending(): PendingFailure[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingFailure[]) : [];
  } catch {
    return [];
  }
}

function writePending(items: PendingFailure[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(items.slice(-MAX_PENDING)));
  } catch {
    // Storage full or disabled: the report is lost, the login itself is unaffected.
  }
}

export function queueCredentialFailure(operation: PendingFailure["operation"], failure: CredentialStoreFailure): void {
  writePending([...readPending(), { operation, failure }]);
}

/** Sends what is queued. Call once signed in. Anything the server did not take stays queued. */
export async function flushCredentialFailures(): Promise<void> {
  const pending = readPending();
  if (pending.length === 0) return;
  const unsent: PendingFailure[] = [];
  for (const item of pending) {
    const res = await reportCredentialStoreFailure(item.operation, item.failure);
    // A rejected report (4xx) will not succeed on a retry either; drop it.
    if (!res.success && isTransientStatus(res.httpStatus)) {
      unsent.push(item);
    }
  }
  writePending(unsent);
}
