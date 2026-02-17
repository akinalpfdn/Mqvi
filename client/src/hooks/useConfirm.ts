/**
 * useConfirm — window.confirm() yerine özel tasarımlı onay dialogu hook'u.
 *
 * Promise tabanlı: `const ok = await confirm({ message: "..." })` şeklinde kullanılır.
 * Boolean döner — true: onaylandı, false: iptal edildi.
 *
 * Kullanım:
 *   const confirm = useConfirm();
 *   async function handleDelete() {
 *     const ok = await confirm({ message: t("deleteConfirm"), danger: true });
 *     if (!ok) return;
 *     // silme işlemi...
 *   }
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
