/**
 * The table truncates every text cell, so a report's full description and message excerpt are only
 * readable in the detail view a row opens. Editing a row's status must not open it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../api/admin", () => ({
  listAdminReports: vi.fn(),
  updateReportStatus: vi.fn(),
  platformBanUser: vi.fn(),
  hardDeleteUser: vi.fn(),
  deleteReportedMessage: vi.fn(),
}));
vi.mock("../../stores/toastStore", () => ({
  useToastStore: <T,>(select: (s: { addToast: () => void }) => T) => select({ addToast: () => {} }),
}));
vi.mock("../../stores/settingsBadgeStore", () => ({
  useSettingsBadgeStore: <T,>(select: (s: { clearReports: () => void }) => T) => select({ clearReports: () => {} }),
}));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock("../../stores/dmStore", () => ({ useDMStore: { getState: () => ({}) } }));
vi.mock("../../stores/uiStore", () => ({ useUIStore: { getState: () => ({}) } }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.resolve(false) }));
vi.mock("../../hooks/useContextMenu", () => ({
  useContextMenu: () => ({ menuState: null, openMenu: () => {}, closeMenu: () => {} }),
}));
vi.mock("../../hooks/useAttachmentViewer", () => ({ useAttachmentViewer: () => () => {} }));
vi.mock("../shared/ContextMenu", () => ({ default: () => null }));
vi.mock("./PlatformBanDialog", () => ({ default: () => null }));
vi.mock("./PlatformActionDialog", () => ({ default: () => null }));

import AdminReportList from "./AdminReportList";
import { listAdminReports } from "../../api/admin";
import type { AdminReportListItem } from "../../types";

const LONG_EXCERPT = "a message long enough that the table cuts it off ".repeat(8).trim();
const LONG_DESCRIPTION = "the reporter explains at length what happened ".repeat(6).trim();

const report: AdminReportListItem = {
  id: "r1",
  reporter_id: "u1",
  reported_user_id: "u2",
  reason: "harassment",
  description: LONG_DESCRIPTION,
  status: "pending",
  resolved_by: null,
  resolved_at: null,
  created_at: "2026-09-25T09:47:00",
  reporter_username: "reporter",
  reporter_display_name: "Reporter",
  reported_username: "reported",
  reported_display_name: null,
  message_id: "m1",
  dm_message_id: null,
  voice_message_id: null,
  message_excerpt: LONG_EXCERPT,
  excerpt_source: "server",
  attachments: [],
};

function detailDialog(): HTMLElement | null {
  return screen.queryByText("platformReportDetails")?.closest(".modal-card") ?? null;
}

beforeEach(() => {
  vi.mocked(listAdminReports).mockResolvedValue({ success: true, data: { reports: [report], total: 1 } });
});

describe("AdminReportList detail view", () => {
  it("shows the full description and message when a row is clicked", async () => {
    render(<AdminReportList />);
    await userEvent.click(await screen.findByText("Reporter"));

    const dialog = detailDialog();
    expect(dialog).not.toBeNull();
    const view = within(dialog as HTMLElement);
    expect(view.getByText(LONG_DESCRIPTION)).toBeTruthy();
    expect(view.getByText(LONG_EXCERPT)).toBeTruthy();
    expect(view.getByText("platformReportMessageHintServer")).toBeTruthy();
    expect(view.getByText("Reporter (@reporter)")).toBeTruthy();
    expect(view.getByText("@reported")).toBeTruthy();
  });

  it("does not open when the row's status is being changed", async () => {
    render(<AdminReportList />);
    const select = await screen.findByDisplayValue("platformReportStatusPending");

    await userEvent.selectOptions(select, "resolved");

    expect(detailDialog()).toBeNull();
    // The change is staged for confirmation, not lost to a modal opening over it.
    expect(screen.getByTitle("save")).toBeTruthy();
  });
});
