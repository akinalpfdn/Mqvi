// Tells the user which files were refused and why. In hooks/ so the pure validator keeps no
// dependency on store or i18n. Count interpolates as `n`: i18next reads `count` as a pluralization
// trigger and would want _one/_other variants these keys do not define.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../stores/toastStore";
import { formatBytes } from "../utils/formatBytes";

/** `type`/`count` cover a file refused for what it is or how many there are; sizes name a limit. */
type Rejection =
  | { reason: "size" | "e2eeSize"; maxBytes: number }
  | { reason: "type" }
  | { reason: "count"; max: number };

const KEYS: Record<Rejection["reason"], { one: string; many: string }> = {
  size: { one: "fileTooLarge", many: "filesTooLarge" },
  e2eeSize: { one: "fileTooLargeEncrypted", many: "filesTooLargeEncrypted" },
  type: { one: "fileTypeNotAllowed", many: "filesTypeNotAllowed" },
  count: { one: "tooManyFiles", many: "tooManyFiles" },
};

function useFileRejectionNotice() {
  const addToast = useToastStore((s) => s.addToast);
  const { t } = useTranslation("common");

  return useCallback(
    // Named files, not File objects: the native picker refuses oversized entries from the size the
    // platform reports, before it ever reads one into memory, so there is no File to hand over.
    (rejected: { name: string }[], rejection: Rejection) => {
      if (rejected.length === 0) return;

      const keys = KEYS[rejection.reason];
      const key = rejected.length === 1 ? keys.one : keys.many;

      // `limit` reads differently per reason: a byte size, a file count, or nothing at all.
      let limit = "";
      if (rejection.reason === "size" || rejection.reason === "e2eeSize") {
        limit = formatBytes(rejection.maxBytes);
      } else if (rejection.reason === "count") {
        limit = String(rejection.max);
      }

      addToast("error", t(key, { name: rejected[0].name, n: rejected.length, limit }));
    },
    [addToast, t]
  );
}

export { useFileRejectionNotice };
export type { Rejection };
