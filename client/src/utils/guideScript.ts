/**
 * The guide's conversation as a function of the user's progress: a greeting, then every step as
 * a card at once, in any order the user likes. Done cards keep their tick; when all are done the
 * guide closes with a finale.
 */

import type { GuideStepId } from "../types";

/** The guide's tab key; one guide tab at most, like any channel. */
export const GUIDE_TAB_ID = "guide";

export const GUIDE_STEPS: readonly GuideStepId[] = ["community", "message", "voice", "friend", "profile", "roles", "app"];

export type GuideItem =
  | { id: string; kind: "message"; textKey: string }
  | { id: string; kind: "card"; step: GuideStepId; done: boolean };

export function guideConversation(steps: Record<GuideStepId, boolean>): GuideItem[] {
  const items: GuideItem[] = [
    { id: "greeting", kind: "message", textKey: "greeting" },
    { id: "intro", kind: "message", textKey: "intro" },
    ...GUIDE_STEPS.map((step): GuideItem => ({ id: `card:${step}`, kind: "card", step, done: steps[step] })),
  ];
  if (GUIDE_STEPS.every((step) => steps[step])) {
    items.push({ id: "finale", kind: "message", textKey: "finale" });
  }
  return items;
}
