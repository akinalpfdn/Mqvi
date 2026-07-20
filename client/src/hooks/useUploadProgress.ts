/**
 * Owns the progress state and the AbortController for one upload surface.
 *
 * `begin()` returns the UploadOptions to hand to an api function; `cancel()` aborts the request in
 * flight. Deliberately does NOT abort on unmount — leaving a channel while a file uploads should
 * let it finish, not silently throw the send away.
 */

import { useCallback, useRef, useState } from "react";
import type { UploadOptions } from "../api/client";

type UploadProgress = { loaded: number; total: number | null };

function useUploadProgress() {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const begin = useCallback((): UploadOptions => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setProgress({ loaded: 0, total: null });
    return {
      signal: controller.signal,
      onProgress: (loaded, total) => setProgress({ loaded, total }),
    };
  }, []);

  const end = useCallback(() => {
    controllerRef.current = null;
    setProgress(null);
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { progress, begin, end, cancel };
}

export { useUploadProgress };
export type { UploadProgress };
