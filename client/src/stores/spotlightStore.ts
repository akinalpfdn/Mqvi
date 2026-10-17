/** spotlightStore — the guide's "Show me" request in flight; GuideSpotlight draws it. */

import { create } from "zustand";

import type { GuideStepId } from "../types";
import type { TourTarget } from "../utils/guideTargets";

type SpotlightRequest = { step: GuideStepId; targets: readonly TourTarget[] };

type SpotlightStore = {
  request: SpotlightRequest | null;
  open: (step: GuideStepId, targets: readonly TourTarget[]) => void;
  close: () => void;
};

export const useSpotlightStore = create<SpotlightStore>((set) => ({
  request: null,
  open: (step, targets) => set({ request: { step, targets } }),
  close: () => set({ request: null }),
}));
