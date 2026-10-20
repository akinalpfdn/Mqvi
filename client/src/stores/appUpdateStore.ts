/**
 * App Update Store — whether the mobile update prompt is on screen, so other prompts (the store
 * review request) stay out of its way. Written only by MobileUpdatePrompt.
 */

import { create } from "zustand";

type AppUpdateState = {
  promptVisible: boolean;
  setPromptVisible: (visible: boolean) => void;
};

export const useAppUpdateStore = create<AppUpdateState>((set) => ({
  promptVisible: false,
  setPromptVisible: (visible) => set({ promptVisible: visible }),
}));
