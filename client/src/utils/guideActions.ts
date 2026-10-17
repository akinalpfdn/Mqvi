/**
 * "Show me" for a guide step: starts its tour. The tour only points; the user opens every
 * drawer, section, menu and dialog on the way themselves.
 */

import { useAuthStore } from "../stores/authStore";
import { useServerStore } from "../stores/serverStore";
import { useSpotlightStore } from "../stores/spotlightStore";
import type { GuideStepId } from "../types";
import { buildTour } from "./guideTours";

export function showGuideStep(step: GuideStepId): void {
  const me = useAuthStore.getState().user?.id;
  const tour = buildTour(step, {
    // Any server of theirs, not only the one in view: the step counts any server they own.
    ownsServer: !!me && useServerStore.getState().servers.some((s) => s.owner_id === me),
  });
  if (tour) useSpotlightStore.getState().open(tour);
}
