/**
 * AdminReportList — Platform admin rapor yonetim tablosu.
 *
 * Ozellikler:
 * - Siralama: Sutun basligina tikla -> asc/desc toggle
 * - Filtreleme: Arama cubuGu + status dropdown filtresi
 * - Sutun genisligi: Sutun kenarini surukleyerek ayarla
 * - Status inline edit: Dropdown degistir -> onay/iptal butonlari
 * - Context menu: DM Reporter, DM Reported, Ban Reported, Delete Reported
 * - Attachment modal: Tiklayinca rapor dosyalarini goruntule
 *
 * AdminUserList pattern'ini birebir takip eder.
 * Sadece is_platform_admin = true olan kullanicilara gorunur.
 * Backend PlatformAdminMiddleware ile korunur.
 */

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { listAdminReports, updateReportStatus, platformBanUser, hardDeleteUser } from "../../api/admin";
import { useContextMenu } from "../../hooks/useContextMenu";
import ContextMenu from "../shared/ContextMenu";
import Modal from "../shared/Modal";
import PlatformBanDialog from "./PlatformBanDialog";
import PlatformActionDialog from "./PlatformActionDialog";
import type { AdminReportListItem } from "../../types";
import { resolveAssetUrl } from "../../utils/constants";
import type { ContextMenuItem } from "../../hooks/useContextMenu";

// --- Column Definition ---

type SortKey =
  | "reporter_username"
  | "reported_username"
  | "reason"
  | "description"
  | "attachments"
  | "created_at"
  | "status";

type ColumnDef = {
  key: SortKey;
  labelKey: string;
  defaultWidth: number;
  minWidth: number;
  sortable: boolean;
  align: "left" | "center" | "right";
};

const COLUMNS: ColumnDef[] = [
  { key: "reporter_username", labelKey: "platformReportReporter", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "reported_username", labelKey: "platformReportReported", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "reason", labelKey: "platformReportReason", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "description", labelKey: "platformReportDescription", defaultWidth: 250, minWidth: 120, sortable: false, align: "left" },
  { key: "attachments", labelKey: "platformReportFiles", defaultWidth: 70, minWidth: 55, sortable: true, align: "center" },
  { key: "created_at", labelKey: "platformReportDate", defaultWidth: 155, minWidth: 120, sortable: true, align: "left" },
  { key: "status", labelKey: "platformReportStatus", defaultWidth: 180, minWidth: 140, sortable: true, align: "left" },
];

function getDefaultWidths(): Record<string, number> {
  const widths: Record<string, number> = {};
  for (const col of COLUMNS) {
    widths[col.key] = col.defaultWidth;
  }
  return widths;
}

/** Backend SQLite timestamp'lerini UTC olarak parse eder. */
function parseUTC(iso: string): number {
  return new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
}

// --- Sort comparator ---

function compareSortValue(
  a: AdminReportListItem,
  b: AdminReportListItem,
  key: SortKey,
  dir: "asc" | "desc",
): number {
  let result = 0;

  switch (key) {
    case "reporter_username":
      result = a.reporter_username.localeCompare(b.reporter_username);
      break;
    case "reported_username":
      result = a.reported_username.localeCompare(b.reported_username);
      break;
    case "reason":
      result = a.reason.localeCompare(b.reason);
      break;
    case "attachments":
      result = a.attachments.length - b.attachments.length;
      break;
    case "created_at":
      result = parseUTC(a.created_at) - parseUTC(b.created_at);
      break;
    case "status":
      result = a.status.localeCompare(b.status);
      break;
    default:
      result = 0;
  }

  return dir === "desc" ? -result : result;
}

// --- Status filter options ---
const STATUS_OPTIONS = ["", "pending", "reviewed", "resolved", "dismissed"] as const;

// --- Reason -> i18n key map ---
const REASON_KEY_MAP: Record<string, string> = {
  spam: "platformReportReasonSpam",
  harassment: "platformReportReasonHarassment",
  inappropriate_content: "platformReportReasonInappropriate",
  impersonation: "platformReportReasonImpersonation",
  other: "platformReportReasonOther",
};

// --- Status -> i18n key map ---
const STATUS_KEY_MAP: Record<string, string> = {
  pending: "platformReportStatusPending",
  reviewed: "platformReportStatusReviewed",
  resolved: "platformReportStatusResolved",
  dismissed: "platformReportStatusDismissed",
};

// --- Component ---

function AdminReportList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const { menuState, openMenu, closeMenu } = useContextMenu();

  // --- Data state ---
  const [reports, setReports] = useState<AdminReportListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // --- Dialog state ---
  const [banTarget, setBanTarget] = useState<{ id: string; username: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; username: string } | null>(null);

  // --- Attachment modal state ---
  const [attachModalReport, setAttachModalReport] = useState<AdminReportListItem | null>(null);

  // --- Table state ---
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(getDefaultWidths);

  // --- Status inline edit state ---
  const [pendingStatusChanges, setPendingStatusChanges] = useState<Record<string, string>>({});
  const [savingReports, setSavingReports] = useState<Set<string>>(new Set());

  // --- Column resize refs ---
  const resizingRef = useRef<{
    col: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const widthsRef = useRef(columnWidths);
  widthsRef.current = columnWidths;

  // --- Fetch ---
  const fetchReports = useCallback(async () => {
    setIsLoading(true);
    const res = await listAdminReports(statusFilter || undefined);
    if (res.success && res.data) {
      setReports(res.data.reports);
    } else {
      addToast("error", res.error ?? t("platformReportLoadError"));
    }
    setIsLoading(false);
  }, [statusFilter, addToast, t]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  // --- Filtered + Sorted data ---
  const filteredReports = useMemo(() => {
    let list = reports;

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.reporter_username.toLowerCase().includes(q) ||
          r.reported_username.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      );
    }

    return [...list].sort((a, b) => compareSortValue(a, b, sortKey, sortDir));
  }, [reports, searchQuery, sortKey, sortDir]);

  // --- Sort handler ---
  function handleSort(key: SortKey) {
    const col = COLUMNS.find((c) => c.key === key);
    if (!col?.sortable) return;

    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // --- Status inline edit ---
  function handleStatusChange(reportId: string, newStatus: string) {
    const report = reports.find((r) => r.id === reportId);
    if (!report) return;

    // Ayni status'a donerse pending change'i sil
    if (newStatus === report.status) {
      setPendingStatusChanges((prev) => {
        const next = { ...prev };
        delete next[reportId];
        return next;
      });
    } else {
      setPendingStatusChanges((prev) => ({ ...prev, [reportId]: newStatus }));
    }
  }

  async function handleStatusConfirm(reportId: string) {
    const newStatus = pendingStatusChanges[reportId];
    if (!newStatus) return;

    setSavingReports((prev) => new Set(prev).add(reportId));

    const res = await updateReportStatus(reportId, newStatus);
    if (res.success) {
      addToast("success", t("platformReportStatusUpdated"));
      setPendingStatusChanges((prev) => {
        const next = { ...prev };
        delete next[reportId];
        return next;
      });
      await fetchReports();
    } else {
      addToast("error", res.error ?? t("platformReportStatusUpdateError"));
    }

    setSavingReports((prev) => {
      const next = new Set(prev);
      next.delete(reportId);
      return next;
    });
  }

  function handleStatusCancel(reportId: string) {
    setPendingStatusChanges((prev) => {
      const next = { ...prev };
      delete next[reportId];
      return next;
    });
  }

  // --- Context Menu ---

  function buildContextItems(report: AdminReportListItem): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    items.push({
      label: t("platformReportDMReporter"),
      onClick: () => handleSendDM(report.reporter_id, report.reporter_display_name ?? report.reporter_username),
    });

    items.push({
      label: t("platformReportDMReported"),
      onClick: () => handleSendDM(report.reported_user_id, report.reported_display_name ?? report.reported_username),
    });

    items.push({
      label: t("platformReportBanReported"),
      danger: true,
      separator: true,
      onClick: () => setBanTarget({ id: report.reported_user_id, username: report.reported_username }),
    });

    items.push({
      label: t("platformReportDeleteReported"),
      danger: true,
      onClick: () => setDeleteTarget({ id: report.reported_user_id, username: report.reported_username }),
    });

    return items;
  }

  async function handleSendDM(userId: string, displayName: string) {
    const channelId = await useDMStore.getState().createOrGetChannel(userId);
    if (channelId) {
      useUIStore.getState().openTab(channelId, "dm", displayName);
      useSettingsStore.getState().closeSettings();
    }
  }

  async function handleBanConfirm(reason: string, deleteMessages: boolean) {
    if (!banTarget) return;
    const targetId = banTarget.id;
    const targetName = banTarget.username;
    setBanTarget(null);

    const res = await platformBanUser(targetId, { reason, delete_messages: deleteMessages });
    if (res.success) {
      addToast("success", t("platformBanSuccess", { username: targetName }));
      await fetchReports();
    } else {
      addToast("error", res.error ?? t("platformBanError"));
    }
  }

  async function handleDeleteConfirm(reason: string) {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    const targetName = deleteTarget.username;
    setDeleteTarget(null);

    const res = await hardDeleteUser(targetId, reason ? { reason } : undefined);
    if (res.success) {
      addToast("success", t("platformDeleteSuccess", { username: targetName }));
      await fetchReports();
    } else {
      addToast("error", res.error ?? t("platformDeleteError"));
    }
  }

  // --- Column resize ---
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, colKey: string) => {
      e.preventDefault();
      e.stopPropagation();

      resizingRef.current = {
        col: colKey,
        startX: e.clientX,
        startWidth: widthsRef.current[colKey] ?? 100,
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizingRef.current) return;

      const { col, startX, startWidth } = resizingRef.current;
      const colDef = COLUMNS.find((c) => c.key === col);
      const minW = colDef?.minWidth ?? 50;
      const newWidth = Math.max(minW, startWidth + (e.clientX - startX));

      setColumnWidths((prev) => ({ ...prev, [col]: newWidth }));
    }

    function onMouseUp() {
      if (!resizingRef.current) return;
      resizingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // --- Helpers ---

  function formatDateTime(iso: string) {
    try {
      return new Date(iso.endsWith("Z") ? iso : iso + "Z").toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function formatFileSize(bytes: number | null) {
    if (bytes === null || bytes === 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  // --- Sort indicator ---
  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return null;
    return (
      <span className="admin-report-sort-icon">
        {sortDir === "asc" ? "\u25B2" : "\u25BC"}
      </span>
    );
  }

  // --- Reason badge ---
  function reasonBadge(reason: string) {
    const labelKey = REASON_KEY_MAP[reason] ?? "platformReportReasonOther";
    return (
      <span className={`admin-report-reason-badge ${reason}`}>
        {t(labelKey)}
      </span>
    );
  }

  // --- Status badge (for non-editable display, not used in table but useful for reference) ---

  // --- Render cell ---
  function renderCell(report: AdminReportListItem, colKey: SortKey) {
    switch (colKey) {
      case "reporter_username":
        return (
          <span title={report.reporter_username}>
            {report.reporter_display_name ?? report.reporter_username}
          </span>
        );

      case "reported_username":
        return (
          <span title={report.reported_username}>
            {report.reported_display_name ?? report.reported_username}
          </span>
        );

      case "reason":
        return reasonBadge(report.reason);

      case "description":
        return (
          <span className="admin-report-desc-cell" title={report.description}>
            {report.description}
          </span>
        );

      case "attachments": {
        const count = report.attachments.length;
        if (count === 0) {
          return <span className="admin-report-text-muted">{"\u2014"}</span>;
        }
        return (
          <button
            className="admin-report-attach-btn"
            onClick={(e) => {
              e.stopPropagation();
              setAttachModalReport(report);
            }}
          >
            {t("platformReportFileCount", { count })}
          </button>
        );
      }

      case "created_at":
        return formatDateTime(report.created_at);

      case "status": {
        const hasPending = pendingStatusChanges[report.id] !== undefined;
        const isSaving = savingReports.has(report.id);
        const currentStatus = hasPending
          ? pendingStatusChanges[report.id]
          : report.status;

        return (
          <div className="admin-report-status-cell">
            <select
              className="admin-report-status-select"
              value={currentStatus}
              onChange={(e) => handleStatusChange(report.id, e.target.value)}
              disabled={isSaving}
            >
              {Object.entries(STATUS_KEY_MAP).map(([value, labelKey]) => (
                <option key={value} value={value}>
                  {t(labelKey)}
                </option>
              ))}
            </select>
            {hasPending && (
              <>
                <button
                  className="admin-report-confirm-btn"
                  onClick={() => handleStatusConfirm(report.id)}
                  disabled={isSaving}
                  title={t("save")}
                >
                  {isSaving ? "..." : "\u2713"}
                </button>
                <button
                  className="admin-report-cancel-btn"
                  onClick={() => handleStatusCancel(report.id)}
                  disabled={isSaving}
                  title={t("cancel")}
                >
                  {"\u2715"}
                </button>
              </>
            )}
          </div>
        );
      }

      default:
        return null;
    }
  }

  // --- Render ---
  if (isLoading) {
    return (
      <div className="admin-report-list">
        <p className="no-channel">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="admin-report-list">
      {/* Toolbar: Search + Status Filter + Count */}
      <div className="admin-report-toolbar">
        <input
          className="admin-report-search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("platformReportSearchPlaceholder")}
        />
        <select
          className="admin-report-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === "" ? t("platformReportStatusAll") : t(STATUS_KEY_MAP[s] ?? s)}
            </option>
          ))}
        </select>
        <span className="admin-report-count">
          {filteredReports.length} / {reports.length}
        </span>
      </div>

      {/* Table */}
      {filteredReports.length === 0 ? (
        <p className="no-channel">
          {reports.length === 0
            ? t("platformReportNoReports")
            : t("platformReportNoResults")}
        </p>
      ) : (
        <div className="admin-report-table-wrap">
          <table className="admin-report-table">
            <colgroup>
              {COLUMNS.map((col) => (
                <col key={col.key} style={{ width: columnWidths[col.key] }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={col.sortable ? "sortable" : ""}
                    onClick={() => handleSort(col.key)}
                  >
                    <div
                      className="admin-report-th-content"
                      style={{ justifyContent: col.align === "right" ? "flex-end" : col.align === "center" ? "center" : "flex-start" }}
                    >
                      <span>{t(col.labelKey)}</span>
                      {sortIndicator(col.key)}
                    </div>
                    {/* Resize handle */}
                    <div
                      className="admin-report-resize-handle"
                      onMouseDown={(e) => handleResizeStart(e, col.key)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredReports.map((report) => (
                <tr
                  key={report.id}
                  onContextMenu={(e) => {
                    const items = buildContextItems(report);
                    if (items.length > 0) openMenu(e, items);
                  }}
                >
                  {COLUMNS.map((col) => (
                    <td key={col.key} style={{ textAlign: col.align }}>
                      {renderCell(report, col.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Context Menu */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* Ban Dialog */}
      {banTarget && (
        <PlatformBanDialog
          username={banTarget.username}
          onConfirm={handleBanConfirm}
          onCancel={() => setBanTarget(null)}
        />
      )}

      {/* Delete Dialog */}
      {deleteTarget && (
        <PlatformActionDialog
          title={t("platformDeleteTitle")}
          description={t("platformDeleteDescription", { username: deleteTarget.username })}
          reasonLabel={t("platformDeleteReasonLabel")}
          reasonPlaceholder={t("platformDeleteReasonPlaceholder")}
          confirmLabel={t("platformDeleteConfirm")}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Attachment Modal */}
      <Modal
        isOpen={!!attachModalReport}
        onClose={() => setAttachModalReport(null)}
        title={t("platformReportAttachments")}
      >
        {attachModalReport && attachModalReport.attachments.length > 0 ? (
          <div className="admin-report-attach-modal">
            {attachModalReport.attachments.map((att) => (
              <div key={att.id} className="admin-report-attach-item">
                {att.mime_type?.startsWith("image/") ? (
                  <img
                    src={resolveAssetUrl(att.file_url)}
                    alt={att.filename}
                    className="admin-report-attach-img"
                  />
                ) : (
                  <a
                    href={resolveAssetUrl(att.file_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="admin-report-attach-link"
                  >
                    {att.filename}
                  </a>
                )}
                <div className="admin-report-attach-info">
                  <span>{att.filename}</span>
                  {att.file_size !== null && <span>{formatFileSize(att.file_size)}</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="admin-report-no-attach">{t("platformReportNoAttachments")}</p>
        )}
      </Modal>
    </div>
  );
}

export default AdminReportList;
