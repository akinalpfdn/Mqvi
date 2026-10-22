/** Drops the signed-out account's in-memory state the moment the session ends. */

import { useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import { resetUserState } from "../stores/shared/resetUserState";

export function useResetOnSignOut(): void {
  useEffect(
    () =>
      useAuthStore.subscribe((state, prev) => {
        if (prev.user && !state.user) resetUserState();
      }),
    []
  );
}
