/**
 * guideStore — the onboarding guide's state, as the server keeps it. Steps are never guessed
 * on the client: they come back from the server, which derives them from what the user did.
 */

import { create } from "zustand";

import * as guideApi from "../api/guide";
import type { GuideState, GuideStepId } from "../types";

/** Lets a burst of events (a server joined, its channels loading) end in one request. */
export const GUIDE_REFRESH_DELAY_MS = 500;
/** The server can write the fact a moment after telling us (voice activity): look once more. */
export const GUIDE_RETRY_DELAY_MS = 2000;

const pending = new Map<GuideStepId, ReturnType<typeof setTimeout>>();

type GuideStore = {
  /** Null until the first load. */
  steps: GuideState["steps"] | null;
  hidden: boolean;
  /** Seeds `hidden` from the signed-in user so the guide row is right before the first load. */
  seed: (hidden: boolean) => void;
  load: () => Promise<void>;
  setHidden: (hidden: boolean) => Promise<boolean>;
  markAppUsed: () => Promise<void>;
  /** The user may just have done `step`: ask the server, unless there is nothing to learn. */
  refreshFor: (step: GuideStepId) => void;
  reset: () => void;
};

export const useGuideStore = create<GuideStore>((set, get) => ({
  steps: null,
  hidden: false,

  seed: (hidden) => set({ hidden }),

  load: async () => {
    const res = await guideApi.getGuide();
    if (res.success && res.data) set({ steps: res.data.steps, hidden: res.data.hidden });
  },

  setHidden: async (hidden) => {
    const res = await guideApi.setGuideHidden(hidden);
    if (!res.success || !res.data) return false;
    set({ steps: res.data.steps, hidden: res.data.hidden });
    return true;
  },

  markAppUsed: async () => {
    const res = await guideApi.markGuideAppUsed();
    if (res.success && res.data) set({ steps: res.data.steps, hidden: res.data.hidden });
  },

  refreshFor: (step) => {
    const needed = () => {
      const { steps, hidden } = get();
      return !hidden && !!steps && !steps[step];
    };
    if (!needed() || pending.has(step)) return;
    const attempt = (delay: number, retry: boolean) => {
      pending.set(
        step,
        setTimeout(async () => {
          await get().load();
          pending.delete(step);
          if (retry && needed()) attempt(GUIDE_RETRY_DELAY_MS, false);
        }, delay),
      );
    };
    attempt(GUIDE_REFRESH_DELAY_MS, true);
  },

  reset: () => {
    pending.forEach(clearTimeout);
    pending.clear();
    set({ steps: null, hidden: false });
  },
}));
