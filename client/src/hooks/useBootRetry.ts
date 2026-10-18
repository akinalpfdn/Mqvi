/**
 * Retries resuming a stored session while the server is unreachable: on a backoff timer, and at
 * once when the network comes back or the app returns to the foreground (a phone resumed, a laptop
 * woken) — the moments the server is most likely to answer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppFocusStore } from "../stores/appFocusStore";

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

function delayFor(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

type BootRetry = {
  /** Whole seconds until the next scheduled attempt; null while one is running. */
  secondsLeft: number | null;
  isRetrying: boolean;
  retryNow: () => void;
};

export function useBootRetry(retry: () => Promise<void>): BootRetry {
  const retryRef = useRef(retry);
  const attemptRef = useRef(0);
  const runningRef = useRef(false);
  const [deadline, setDeadline] = useState<number | null>(() => Date.now() + delayFor(0));
  const [now, setNow] = useState(() => Date.now());

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
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

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

  const retryNow = useCallback(() => void run(), [run]);

  return {
    secondsLeft: deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1_000)),
    isRetrying: deadline === null,
    retryNow,
  };
}
