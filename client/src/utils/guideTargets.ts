/**
 * Where "Show me" points for each guide step. Targets carry a stable `data-tour` marker; the
 * list is in order of preference, so a step whose real target does not exist yet (no server,
 * so no channels) points at what comes before it instead.
 */

import type { GuideStepId } from "../types";

export type TourTarget = "discover" | "add-server" | "server" | "channel-text" | "channel-voice" | "friends";

export const STEP_TOUR: Partial<Record<GuideStepId, readonly TourTarget[]>> = {
  community: ["discover"],
  message: ["channel-text", "server", "discover"],
  voice: ["channel-voice", "server", "discover"],
  dm: ["friends"],
  friend: ["friends"],
  roles: ["add-server"],
};

function isShown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** The first shown element for the most preferred target that has one; active rows first. */
export function findTourTarget(targets: readonly TourTarget[]): { target: TourTarget; element: HTMLElement } | null {
  for (const target of targets) {
    const shown = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)).filter(isShown);
    const element = shown.find((el) => el.classList.contains("active")) ?? shown[0];
    if (element) return { target, element };
  }
  return null;
}

/** Caption for a step, or — when it had to point elsewhere — for the target it fell back to. */
export function tourCaptionKey(step: GuideStepId, preferred: TourTarget, found: TourTarget): string {
  return found === preferred ? `spotlight.${step}` : `spotlight.fallback.${found}`;
}
