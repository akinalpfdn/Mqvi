/** spotlightStore — the guide tour in progress; GuideSpotlight draws it. */

import { create } from "zustand";

import type { Tour } from "../utils/guideTours";

type SpotlightStore = {
  tour: Tour | null;
  open: (tour: Tour) => void;
  close: () => void;
};

export const useSpotlightStore = create<SpotlightStore>((set) => ({
  tour: null,
  open: (tour) => set({ tour }),
  close: () => set({ tour: null }),
}));
