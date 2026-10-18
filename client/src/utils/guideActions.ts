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
  const servers = useServerStore.getState().servers;
  const tour = buildTour(step, {
    hasServer: servers.length > 0,
    // Any server of theirs, not only the one in view: the step counts any server they own.
    ownsServer: !!me && servers.some((s) => s.owner_id === me),
  });
  if (tour) useSpotlightStore.getState().open(tour);
}
