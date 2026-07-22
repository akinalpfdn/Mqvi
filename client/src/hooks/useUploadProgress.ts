// Progress state and AbortController for one upload surface. Deliberately does NOT abort on
// unmount: leaving a channel while a file uploads should let it finish.

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
      // An earlier upload on this surface is deliberately left running (see the note above), so its
      // progress events are ignored rather than aborted — otherwise starting a second send would
      // kill the first, which is the opposite of what this hook promises.
      onProgress: (loaded, total) => {
        if (controllerRef.current !== controller) return;
        setProgress({ loaded, total });
      },
    };
  }, []);

  // Takes the options begin() handed out so an earlier upload finishing cannot clear a newer one's
  // controller — that would silently drop the newer upload's progress and make cancel() a no-op.
  const end = useCallback((options: UploadOptions | undefined) => {
    if (controllerRef.current?.signal !== options?.signal) return;
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
