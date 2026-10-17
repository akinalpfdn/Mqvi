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
  const server = useServerStore.getState().activeServer;
  const tour = buildTour(step, {
    ownsServer: !!server && server.owner_id === useAuthStore.getState().user?.id,
  });
  if (tour) useSpotlightStore.getState().open(tour);
}
