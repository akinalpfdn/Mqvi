/** Tabs saved before a restart come back with fresh ids; what can no longer open is dropped. */
import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore, type Tab } from "./uiStore";

const tab = (id: string, type: Tab["type"], channelId: string): Tab => ({ id, type, channelId, label: channelId });

beforeEach(() => {
  useUIStore.setState({ panels: {}, layout: { type: "leaf", panelId: "none" }, activePanelId: "none" });
});

describe("restoreLayout", () => {
  it("should collapse a split whose other side has nothing left to open", () => {
    useUIStore.getState().restoreLayout(
      {
        panels: {
          left: { id: "left", tabs: [tab("t1", "text", "c1"), tab("t2", "dm", "d1")], activeTabId: "t2" },
          right: { id: "right", tabs: [tab("t3", "voice", "v1"), tab("t4", "text", "gone")], activeTabId: "t3" },
        },
        layout: { type: "split", direction: "horizontal", ratio: 0.5, children: [
          { type: "leaf", panelId: "left" }, { type: "leaf", panelId: "right" },
        ] },
        activePanelId: "right",
      },
      (t) => t.channelId !== "gone"
    );

    const { panels, layout, activePanelId } = useUIStore.getState();
    const [panel] = Object.values(panels);
    expect(Object.keys(panels)).toHaveLength(1);
    expect(layout).toEqual({ type: "leaf", panelId: panel.id });
    expect(activePanelId).toBe(panel.id);
    expect(panel.tabs.map((t) => t.channelId)).toEqual(["c1", "d1"]);
    // The active tab is the same conversation, under its new id.
    expect(panel.tabs.find((t) => t.id === panel.activeTabId)?.channelId).toBe("d1");
  });

  it("should keep the empty start when nothing can be reopened", () => {
    const before = useUIStore.getState();

    useUIStore.getState().restoreLayout(
      { panels: { p: { id: "p", tabs: [tab("t1", "voice", "v1")], activeTabId: "t1" } }, layout: { type: "leaf", panelId: "p" }, activePanelId: "p" },
      () => true
    );

    expect(useUIStore.getState().panels).toBe(before.panels);
  });
});
