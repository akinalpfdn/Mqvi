/**
 * Toast Store — Global toast notification management.
 *
 * Timer IDs are kept in a module-level Map (not in state) because
 * setTimeout IDs aren't serializable and would cause unnecessary re-renders.
 */

import { create } from "zustand";

type ToastType = "success" | "error" | "warning" | "info";

type Toast = {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  /** Exit animation active — fade-out before removal */
  isExiting: boolean;
};

type ToastState = {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number) => void;
  /** Triggers exit animation, then removes from state after 300ms. */
  removeToast: (id: string) => void;
};

/** Auto-dismiss timer IDs — kept outside state (not serializable) */
const timerMap = new Map<string, ReturnType<typeof setTimeout>>();

const MAX_VISIBLE = 5;
const DEFAULT_DURATION = 4000;
/** Must match CSS transition duration */
const EXIT_ANIMATION_MS = 300;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (type, message, duration = DEFAULT_DURATION) => {
    const id = crypto.randomUUID();

    const toast: Toast = {
      id,
      type,
      message,
      duration,
      isExiting: false,
    };

    set((state) => {
      const updatedToasts = [...state.toasts, toast];
      if (updatedToasts.length > MAX_VISIBLE) {
        const removed = updatedToasts.splice(0, updatedToasts.length - MAX_VISIBLE);
        for (const r of removed) {
          const timerId = timerMap.get(r.id);
          if (timerId) {
            clearTimeout(timerId);
            timerMap.delete(r.id);
          }
        }
      }
      return { toasts: updatedToasts };
    });

    const timerId = setTimeout(() => {
      get().removeToast(id);
    }, duration);

    timerMap.set(id, timerId);
  },

  removeToast: (id) => {
    const timerId = timerMap.get(id);
    if (timerId) {
      clearTimeout(timerId);
      timerMap.delete(id);
    }

    // Start exit animation
    set((state) => ({
      toasts: state.toasts.map((t) =>
        t.id === id ? { ...t, isExiting: true } : t
      ),
    }));

    // Remove from state after animation completes
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, EXIT_ANIMATION_MS);
  },
}));
