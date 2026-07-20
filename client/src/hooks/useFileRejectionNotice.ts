/**
 * Tells the user which files were refused and why.
 *
 * Lives in hooks/ rather than utils/ so the pure validator keeps no dependency on the store or i18n
 * layers — utils must not reach upward.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../stores/toastStore";
import { formatBytes } from "../utils/formatBytes";

type RejectionKind = "size" | "e2eeSize";

function useFileRejectionNotice() {
  const addToast = useToastStore((s) => s.addToast);
  const { t } = useTranslation("common");

  return useCallback(
    (rejected: File[], maxBytes: number, kind: RejectionKind = "size") => {
      if (rejected.length === 0) return;

      const limit = formatBytes(maxBytes);
      const key =
        rejected.length === 1
          ? kind === "e2eeSize"
            ? "fileTooLargeEncrypted"
            : "fileTooLarge"
          : kind === "e2eeSize"
            ? "filesTooLargeEncrypted"
            : "filesTooLarge";

      addToast(
        "error",
        t(key, { name: rejected[0].name, count: rejected.length, limit })
      );
    },
    [addToast, t]
  );
}

export { useFileRejectionNotice };
