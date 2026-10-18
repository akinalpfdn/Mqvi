/** Tours walk through real controls; the spotlight sits on the deepest one on screen. */
import { describe, it, expect, beforeEach } from "vitest";

import { buildTour, channelTourTarget, currentStage, voicePanelTour, VOICE_PANEL_STOPS } from "./guideTours";

function add(tour: string, { onScreen = true, active = false } = {}) {
  const el = document.createElement("button");
  el.dataset.tour = tour;
  if (active) el.classList.add("active");
  const left = onScreen ? 10 : -400; // a closed drawer sits off the left edge
  el.getBoundingClientRect = () => ({ width: 100, height: 30, top: 50, left, right: left + 100, bottom: 80 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const ctx = { hasServer: true, ownsServer: false };

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("guide tours", () => {
  it("never opens anything: every tour starts at a control the user opens", () => {
    for (const step of ["community", "message", "voice", "friend", "profile", "roles"] as const) {
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

  it("walks the owner through their own server and its settings to creating a role", () => {
    expect(buildTour("roles", { ...ctx, ownsServer: true })?.stages.map((s) => s.target).slice(-5)).toEqual([
      "owned-server",
      "server-settings",
      "settings-menu",
      "settings-roles",
      "create-role",
    ]);
  });

  it("sends someone without a server of their own to create one", () => {
    expect(buildTour("roles", ctx)).toMatchObject({ scope: "rolesNoServer", stages: expect.arrayContaining([{ target: "add-server", final: true }]) });
  });

  it("sends someone in no server to join a community before a channel or voice", () => {
    for (const step of ["message", "voice"] as const) {
      const tour = buildTour(step, { hasServer: false, ownsServer: false });
      expect(tour?.scope).toBe("noServer");
      expect(tour?.stages.map((s) => s.target).slice(2)).toEqual(["servers-section", "discover", "discovery-join"]);
      expect(tour?.stages.at(-1)?.final).toBe(true);
      expect(tour?.explain).toBeUndefined();
    }
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

  it("not on a control under an open drawer, which leaves the drawer's own control", () => {
    const covered = document.createElement("div");
    covered.setAttribute("inert", "");
    document.body.appendChild(covered);
    const servers = add("servers-section");
    covered.appendChild(add("discover"));
    expect(currentStage(stages)?.element).toBe(servers);
  });

  it("on a control that carries the marker among several", () => {
    add("server"); // someone else's server
    const own = add("server owned-server");
    expect(currentStage([{ target: "owned-server" }])?.element).toBe(own);
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

describe("which channels a tour may point at", () => {
  const text = { isText: true, canSend: true, isVoiceLocked: false, participants: 0, userLimit: 0 };
  const voice = { ...text, isText: false, canSend: false };

  it("a text channel the user can write in", () => {
    expect(channelTourTarget(text)).toBe("channel-text");
    expect(channelTourTarget({ ...text, canSend: false })).toBeUndefined();
  });

  it("a voice channel the user can join", () => {
    expect(channelTourTarget(voice)).toBe("channel-voice");
    expect(channelTourTarget({ ...voice, isVoiceLocked: true })).toBeUndefined();
  });

  it("not a full voice channel, but one with room", () => {
    expect(channelTourTarget({ ...voice, userLimit: 5, participants: 5 })).toBeUndefined();
    expect(channelTourTarget({ ...voice, userLimit: 5, participants: 4 })).toBe("channel-voice");
  });
});

