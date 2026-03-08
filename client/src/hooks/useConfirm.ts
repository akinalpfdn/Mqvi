/**
 * useConfirm — Promise-based custom confirm dialog hook.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   const ok = await confirm({ message: t("deleteConfirm"), danger: true });
 *   if (!ok) return;
 */

import { useCallback } from "react";
import { useConfirmStore } from "../stores/confirmStore";

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export function useConfirm() {
  const open = useConfirmStore((s) => s.open);

  return useCallback(
    (options: ConfirmOptions) => open(options),
    [open]
  );
}
