/**
 * Confirm Store — Global promise-based confirmation dialog.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   const ok = await confirm({ title: "...", message: "..." });
 *   if (ok) { ... }
 */

import { create } from "zustand";

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red button styling for destructive actions */
  danger?: boolean;
};

type ConfirmState = {
  /** Active dialog data — null means closed */
  options: ConfirmOptions | null;
  /** Promise resolver — called when dialog closes */
  resolver: ((value: boolean) => void) | null;

  open: (options: ConfirmOptions) => Promise<boolean>;
  confirm: () => void;
  cancel: () => void;
};

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  options: null,
  resolver: null,

  open: (options) => {
    return new Promise<boolean>((resolve) => {
      set({ options, resolver: resolve });
    });
  },

  confirm: () => {
    const { resolver } = get();
    if (resolver) resolver(true);
    set({ options: null, resolver: null });
  },

  cancel: () => {
    const { resolver } = get();
    if (resolver) resolver(false);
    set({ options: null, resolver: null });
  },
}));
