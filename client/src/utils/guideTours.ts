/**
 * "Show me" tours. A tour is a chain of real controls, shallowest first; the spotlight always
 * points at the deepest one on screen, so it walks forward as the user opens things — a closed
 * drawer shows the menu button, an open one the control inside it. The guide never opens
 * anything itself. A tour ends when the user uses its final control.
 *
 * Controls carry a stable `data-tour` marker. Section headers carry theirs only while collapsed,
 * so an open section never pulls the spotlight back to its header.
 */

import type { GuideStepId } from "../types";

export type TourStage = { target: string; final?: boolean };

export type Tour = {
  step: GuideStepId;
  /** Caption namespace: the step, or a variant of it ("dmNoFriend"). */
  scope: string;
  stages: readonly TourStage[];
};

export type TourContext = {
  /** The user owns the server in view, so its settings (and roles) are theirs to open. */
  ownsServer: boolean;
  hasFriends: boolean;
};

/** A hidden sidebar comes first: collapsed on desktop, a closed drawer on a phone. */
const SIDEBAR: TourStage[] = [{ target: "sidebar-expand" }, { target: "menu" }];
const FINAL = (target: string): TourStage => ({ target, final: true });

const FRIEND: TourStage[] = [
  ...SIDEBAR,
  { target: "friends-section" },
  { target: "friends" },
  { target: "add-friend-tab" },
  FINAL("add-friend-input"),
];

export function buildTour(step: GuideStepId, ctx: TourContext): Tour | null {
  switch (step) {
    case "community":
      return { step, scope: step, stages: [...SIDEBAR, { target: "servers-section" }, { target: "discover" }, FINAL("discovery-join")] };
    case "message":
      return {
        step,
        scope: step,
        stages: [...SIDEBAR, { target: "servers-section" }, { target: "server" }, { target: "channel-text" }, FINAL("composer")],
      };
    case "voice":
      return { step, scope: step, stages: [...SIDEBAR, { target: "servers-section" }, { target: "server" }, FINAL("channel-voice")] };
    case "friend":
      return { step, scope: step, stages: FRIEND };
    case "dm":
      if (!ctx.hasFriends) return { step, scope: "dmNoFriend", stages: FRIEND };
      return {
        step,
        scope: step,
        stages: [
          ...SIDEBAR,
          { target: "friends-section" },
          { target: "friends" },
          { target: "friend-row" },
          { target: "send-message" },
          FINAL("dm-composer"),
        ],
      };
    case "profile":
      return {
        step,
        scope: step,
        stages: [...SIDEBAR, { target: "user-settings" }, { target: "settings-menu" }, { target: "settings-profile" }, FINAL("avatar")],
      };
    case "roles":
      if (!ctx.ownsServer) {
        return { step, scope: "rolesNoServer", stages: [...SIDEBAR, { target: "servers-section" }, FINAL("add-server")] };
      }
      return {
        step,
        scope: step,
        stages: [
          ...SIDEBAR,
          { target: "servers-section" },
          { target: "server" },
          { target: "server-settings" },
          { target: "settings-menu" },
          { target: "settings-roles" },
          FINAL("create-role"),
        ],
      };
    case "app":
      return null; // its card links to the download itself
  }
}

function isOnScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
}

/** The deepest stage with a control on screen; among several such controls, the active one. */
export function currentStage(stages: readonly TourStage[]): { stage: TourStage; element: HTMLElement } | null {
  for (let i = stages.length - 1; i >= 0; i--) {
    const shown = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${stages[i].target}"]`)).filter(isOnScreen);
    const element = shown.find((el) => el.classList.contains("active")) ?? shown[0];
    if (element) return { stage: stages[i], element };
  }
  return null;
}
