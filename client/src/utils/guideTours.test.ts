/** Tours walk through real controls; the spotlight sits on the deepest one on screen. */
import { describe, it, expect, beforeEach } from "vitest";

import { buildTour, currentStage, voicePanelTour, VOICE_PANEL_STOPS } from "./guideTours";

function add(tour: string, { onScreen = true, active = false } = {}) {
  const el = document.createElement("button");
  el.dataset.tour = tour;
  if (active) el.classList.add("active");
  const left = onScreen ? 10 : -400; // a closed drawer sits off the left edge
  el.getBoundingClientRect = () => ({ width: 100, height: 30, top: 50, left, right: left + 100, bottom: 80 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const ctx = { ownsServer: false, hasFriends: false };

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("guide tours", () => {
  it("never opens anything: every tour starts at a control the user opens", () => {
    for (const step of ["community", "message", "dm", "voice", "friend", "profile", "roles"] as const) {
      const tour = buildTour(step, ctx);
      expect(tour?.stages[0].target).toBe("sidebar-expand");
      expect(tour?.stages.at(-1)?.final).toBe(true);
    }
  });

  it("adds a friend through Friends, the Add Friend tab and the username field", () => {
    expect(buildTour("friend", ctx)?.stages.map((s) => s.target).slice(2)).toEqual([
      "friends-section",
      "friends",
      "add-friend-tab",
      "add-friend-input",
    ]);
  });

  it("walks the owner through server settings to creating a role", () => {
    expect(buildTour("roles", { ...ctx, ownsServer: true })?.stages.map((s) => s.target).slice(-4)).toEqual([
      "server-settings",
      "settings-menu",
      "settings-roles",
      "create-role",
    ]);
  });

  it("sends someone without a server of their own to create one", () => {
    expect(buildTour("roles", ctx)).toMatchObject({ scope: "rolesNoServer", stages: expect.arrayContaining([{ target: "add-server", final: true }]) });
  });

  it("sends someone with no friends to add one before messaging", () => {
    expect(buildTour("dm", ctx)?.scope).toBe("dmNoFriend");
    expect(buildTour("dm", { ...ctx, hasFriends: true })?.stages.at(-1)).toEqual({ target: "dm-composer", final: true });
  });

  it("introduces the voice panel after joining voice, and on its own for a replay", () => {
    expect(buildTour("voice", ctx)?.explain).toEqual(VOICE_PANEL_STOPS);
    expect(voicePanelTour()).toMatchObject({ stages: [], explain: VOICE_PANEL_STOPS });
  });

  it("has no tour for the app, whose card links to the download", () => {
    expect(buildTour("app", ctx)).toBeNull();
  });
});

describe("where the spotlight sits", () => {
  const stages = [{ target: "menu" }, { target: "servers-section" }, { target: "discover", final: true }];

  it("on the deepest control on screen", () => {
    add("menu");
    const discover = add("discover");
    expect(currentStage(stages)?.element).toBe(discover);
  });

  it("on the menu button while the drawer holding the rest is closed", () => {
    const menu = add("menu");
    add("discover", { onScreen: false });
    expect(currentStage(stages)?.element).toBe(menu);
  });

  it("on the active row among several", () => {
    add("server");
    const active = add("server", { active: true });
    expect(currentStage([{ target: "server" }])?.element).toBe(active);
  });

  it("nowhere when nothing of the tour is on screen", () => {
    expect(currentStage(stages)).toBeNull();
  });
});
