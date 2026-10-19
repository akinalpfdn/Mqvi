/**
 * Retries resuming a stored session while the server is unreachable: on a backoff timer, and at
 * once when the network comes back or the app returns to the foreground (a phone resumed, a laptop
 * woken) — the moments the server is most likely to answer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppFocusStore } from "../stores/appFocusStore";

/** Quick at first (a restart or a blip clears in seconds), then settling at 15s. */
const RETRY_DELAYS_MS = [1_000, 1_000, 2_000, 2_000, 2_000, 3_000, 5_000, 7_000, 10_000, 15_000];

function delayFor(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

export function useBootRetry(retry: () => Promise<void>): void {
  const retryRef = useRef(retry);
  const attemptRef = useRef(0);
  const runningRef = useRef(false);
  const [deadline, setDeadline] = useState<number | null>(() => Date.now() + delayFor(0));

  useEffect(() => {
    retryRef.current = retry;
  }, [retry]);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setDeadline(null);
    try {
      await retryRef.current();
    } finally {
      runningRef.current = false;
      attemptRef.current += 1;
      setDeadline(Date.now() + delayFor(attemptRef.current));
    }
  }, []);

  useEffect(() => {
    if (deadline === null) return;
    const id = setTimeout(() => void run(), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(id);
  }, [deadline, run]);

  useEffect(() => {
    const onOnline = () => void run();
    window.addEventListener("online", onOnline);
    const unsubscribe = useAppFocusStore.subscribe((state, prev) => {
      if (state.isForeground === true && prev.isForeground !== true) void run();
    });
    return () => {
      window.removeEventListener("online", onOnline);
      unsubscribe();
    };
  }, [run]);
}
