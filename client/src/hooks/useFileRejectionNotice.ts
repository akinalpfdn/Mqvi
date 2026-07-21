// Tells the user which files were refused and why. In hooks/ so the pure validator keeps no
// dependency on store or i18n. Count interpolates as `n`: i18next reads `count` as a pluralization
// trigger and would want _one/_other variants these keys do not define.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../stores/toastStore";
import { formatBytes } from "../utils/formatBytes";

/** `type` covers a file refused for what it is; the size reasons carry a limit to name. */
type Rejection =
  | { reason: "size" | "e2eeSize"; maxBytes: number }
  | { reason: "type" };

const KEYS: Record<Rejection["reason"], { one: string; many: string }> = {
  size: { one: "fileTooLarge", many: "filesTooLarge" },
  e2eeSize: { one: "fileTooLargeEncrypted", many: "filesTooLargeEncrypted" },
  type: { one: "fileTypeNotAllowed", many: "filesTypeNotAllowed" },
};

function useFileRejectionNotice() {
  const addToast = useToastStore((s) => s.addToast);
  const { t } = useTranslation("common");

  return useCallback(
    (rejected: File[], rejection: Rejection) => {
      if (rejected.length === 0) return;

      const keys = KEYS[rejection.reason];
      const key = rejected.length === 1 ? keys.one : keys.many;

      addToast(
        "error",
        t(key, {
          name: rejected[0].name,
          n: rejected.length,
          limit: rejection.reason === "type" ? "" : formatBytes(rejection.maxBytes),
        })
      );
    },
    [addToast, t]
  );
}

export { useFileRejectionNotice };
export type { Rejection };
