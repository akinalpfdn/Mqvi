/**
 * guideStore — the onboarding guide's state, as the server keeps it. Steps are never guessed
 * on the client: they come back from the server, which derives them from what the user did.
 */

import { create } from "zustand";

import * as guideApi from "../api/guide";
import type { GuideState } from "../types";

type GuideStore = {
  /** Null until the first load. */
  steps: GuideState["steps"] | null;
  hidden: boolean;
  /** Seeds `hidden` from the signed-in user so the guide row is right before the first load. */
  seed: (hidden: boolean) => void;
  load: () => Promise<void>;
  setHidden: (hidden: boolean) => Promise<boolean>;
  markAppUsed: () => Promise<void>;
  reset: () => void;
};

export const useGuideStore = create<GuideStore>((set) => ({
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

  reset: () => set({ steps: null, hidden: false }),
}));
