/** AdminServerList — Platform admin server management table with LiveKit instance migration. */

import { useEffect, useState, useCallback, useRef } from "react";
import Pagination from "../shared/Pagination";
import FilterDropdown from "../shared/FilterDropdown";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import {
  listLiveKitInstances,
  listAdminServers,
  migrateServerInstance,
  adminDeleteServer,
  setServerDiscoveryFlag,
  type DiscoveryFlag,
} from "../../api/admin";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useConfirm } from "../../hooks/useConfirm";
import ContextMenu from "../shared/ContextMenu";
import PlatformActionDialog from "./PlatformActionDialog";
import type { LiveKitInstanceAdmin, AdminServerListItem } from "../../types";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import { resolveAssetUrl } from "../../utils/constants";

// ─── Column Definition ───

type SortKey =
  | "name"
  | "id"
  | "owner_username"
  | "created_at"
  | "type"
  | "member_count"
  | "channel_count"
  | "message_count"
  | "storage_mb"
  | "last_activity"
  | "instance";

type ColumnDef = {
  key: SortKey;
  labelKey: string;
  defaultWidth: number;
  minWidth: number;
  sortable: boolean;
  align: "left" | "center" | "right";
};

const COLUMNS: ColumnDef[] = [
  { key: "name", labelKey: "platformServerName", defaultWidth: 180, minWidth: 120, sortable: true, align: "left" },
  { key: "id", labelKey: "platformServerID", defaultWidth: 110, minWidth: 80, sortable: false, align: "left" },
  { key: "owner_username", labelKey: "platformServerCreator", defaultWidth: 110, minWidth: 80, sortable: true, align: "left" },
  { key: "created_at", labelKey: "platformServerCreated", defaultWidth: 120, minWidth: 90, sortable: true, align: "left" },
  { key: "type", labelKey: "platformServerType", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "member_count", labelKey: "platformServerMembers", defaultWidth: 80, minWidth: 60, sortable: true, align: "right" },
  { key: "channel_count", labelKey: "platformServerChannels", defaultWidth: 80, minWidth: 60, sortable: true, align: "right" },
  { key: "message_count", labelKey: "platformServerMessages", defaultWidth: 90, minWidth: 70, sortable: true, align: "right" },
  { key: "storage_mb", labelKey: "platformServerStorage", defaultWidth: 85, minWidth: 65, sortable: true, align: "right" },
  { key: "last_activity", labelKey: "platformServerLastActivity", defaultWidth: 110, minWidth: 80, sortable: true, align: "left" },
  { key: "instance", labelKey: "platformServerLiveKitInstance", defaultWidth: 210, minWidth: 150, sortable: false, align: "left" },
];

function getDefaultWidths(): Record<string, number> {
  const widths: Record<string, number> = {};
  for (const col of COLUMNS) {
    widths[col.key] = col.defaultWidth;
  }
  return widths;
}

/** SQLite timestamps lack "Z" suffix — append it to ensure UTC parsing. */
function parseUTC(iso: string): number {
  return new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
}

// "type" is the UI sort key for platform-managed flag — backend column is is_platform_managed.
const SORT_KEY_TO_BACKEND: Partial<Record<SortKey, string>> = {
  type: "is_platform_managed",
};
function backendSortKey(k: SortKey): string {
  return SORT_KEY_TO_BACKEND[k] ?? k;
}

// ─── Component ───

function AdminServerList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();
  const { menuState, openMenu, closeMenu } = useContextMenu();

  // ─── Data state ───
  const [servers, setServers] = useState<AdminServerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [instances, setInstances] = useState<LiveKitInstanceAdmin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Pagination ───
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // ─── Delete dialog state ───
  const [deleteTarget, setDeleteTarget] = useState<AdminServerListItem | null>(null);

  // ─── Table state ───
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Multi-select filters — combine with AND across dimensions, OR within. Empty = all.
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(getDefaultWidths);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ─── Migration state ───
  const [pendingChanges, setPendingChanges] = useState<Record<string, string>>({});
  const [savingServers, setSavingServers] = useState<Set<string>>(new Set());

  // ─── Column resize refs ───
  const resizingRef = useRef<{
    col: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const widthsRef = useRef(columnWidths);
  widthsRef.current = columnWidths;

  // ─── Fetch (server-side filter/sort/paging) ───
  const [refetchTick, setRefetchTick] = useState(0);

  // Instances list is small and orthogonal to server pagination — load once.
  useEffect(() => {
    let cancelled = false;
    listLiveKitInstances().then((res) => {
      if (cancelled) return;
      if (res.success && res.data) setInstances(res.data);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      const res = await listAdminServers({
        limit: pageSize,
        offset: page * pageSize,
        search: debouncedSearch || undefined,
        statuses: statusFilter,
        types: typeFilter,
        sort: backendSortKey(sortKey),
        dir: sortDir,
      });
      if (cancelled) return;
      if (res.success && res.data) {
        if ((res.data.items?.length ?? 0) === 0 && res.data.total > 0 && page > 0) {
          const lastPage = Math.max(0, Math.ceil(res.data.total / pageSize) - 1);
          setPage(lastPage);
          return;
        }
        setServers(res.data.items ?? []);
        setTotal(res.data.total);
      } else {
        addToast("error", res.error ?? t("platformServerLoadError"));
      }
      setIsLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [page, pageSize, debouncedSearch, statusFilter, typeFilter, sortKey, sortDir, refetchTick, addToast, t]);

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, statusFilter, typeFilter, sortKey, sortDir, pageSize]);

  // ─── Sort handler ───
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

  // ─── Column resize ───
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

  // ─── Instance change ───
  function handleInstanceChange(serverId: string, newInstanceId: string) {
    const server = servers.find((s) => s.id === serverId);
    if (server?.livekit_instance_id === newInstanceId) {
      setPendingChanges((prev) => {
        const copy = { ...prev };
        delete copy[serverId];
        return copy;
      });
    } else {
      setPendingChanges((prev) => ({ ...prev, [serverId]: newInstanceId }));
    }
  }

  function handleCancelChange(serverId: string) {
    setPendingChanges((prev) => {
      const copy = { ...prev };
      delete copy[serverId];
      return copy;
    });
  }

  async function handleConfirm(serverId: string) {
    const newInstanceId = pendingChanges[serverId];
    if (!newInstanceId) return;

    setSavingServers((prev) => new Set(prev).add(serverId));
    const res = await migrateServerInstance(serverId, newInstanceId);
    setSavingServers((prev) => {
      const copy = new Set(prev);
      copy.delete(serverId);
      return copy;
    });

    if (res.success) {
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, livekit_instance_id: newInstanceId, is_platform_managed: true }
            : s,
        ),
      );
      setPendingChanges((prev) => {
        const copy = { ...prev };
        delete copy[serverId];
        return copy;
      });
      addToast("success", t("platformServerInstanceUpdated"));
    } else {
      addToast("error", res.error ?? t("platformServerInstanceUpdateError"));
    }
  }

  // ─── Helpers ───
  function formatDate(iso: string) {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }

  function formatRelativeTime(iso: string | null) {
    if (!iso) return t("platformServerNever");
    try {
      const diff = Date.now() - parseUTC(iso);
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return t("platformServerJustNow");
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days}d`;
      return formatDate(iso);
    } catch {
      return iso ?? "";
    }
  }

  function formatStorage(mb: number) {
    if (mb < 0.01) return "0 MB";
    if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
  }

  function instanceLabel(id: string) {
    const inst = instances.find((i) => i.id === id);
    if (!inst) return id;
    try {
      return new URL(inst.url).hostname;
    } catch {
      return inst.url;
    }
  }

  // ─── Context Menu ───

  const refetchServers = useCallback(() => {
    setRefetchTick((n) => n + 1);
  }, []);

  async function handleToggleFlag(srv: AdminServerListItem, flag: DiscoveryFlag, current: boolean) {
    const res = await setServerDiscoveryFlag(srv.id, flag, !current);
    if (res.success) {
      addToast("success", t("discoveryFlagUpdated"));
      await refetchServers();
    } else {
      addToast("error", res.error ?? t("discoveryFlagError"));
    }
  }

  function buildContextItems(srv: AdminServerListItem): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    items.push({
      label: t("platformServerSendDMOwner"),
      onClick: () => handleSendDMOwner(srv),
    });

    // Discovery badges + unlist (checkmark prefix shows the current state).
    if (!srv.deleted_at) {
      items.push({
        label: (srv.verified ? "✓ " : "") + t("badgeVerified"),
        separator: true,
        onClick: () => handleToggleFlag(srv, "verified", srv.verified),
      });
      items.push({
        label: (srv.featured ? "✓ " : "") + t("badgeFeatured"),
        onClick: () => handleToggleFlag(srv, "featured", srv.featured),
      });
      items.push({
        label: (srv.discovery_blocked ? "✓ " : "") + t("badgeUnlisted"),
        onClick: () => handleToggleFlag(srv, "discovery_blocked", srv.discovery_blocked),
      });
    }

    if (!srv.deleted_at) {
      items.push({
        label: t("platformServerDelete"),
        danger: true,
        separator: true,
        onClick: () => setDeleteTarget(srv),
      });
    } else {
      items.push({
        label: t("restore"),
        separator: true,
        onClick: () => {
          void (async () => {
            const { adminRestoreServer } = await import("../../api/admin");
            const res = await adminRestoreServer(srv.id);
            if (res.success) {
              addToast("success", t("restoreServerSuccess"));
              await refetchServers();
            } else {
              addToast("error", res.error ?? t("restoreServerFailed"));
            }
          })();
        },
      });
      // Skip the 30-day TTL for an already soft-deleted server. Admin path goes
      // through the same delete endpoint with hard_delete=true.
      items.push({
        label: t("platformServerHardDeleteNow"),
        danger: true,
        onClick: () => {
          void (async () => {
            const ok = await confirm({
              title: t("platformServerHardDeleteNowTitle"),
              message: t("platformServerHardDeleteNowConfirm", { name: srv.name }),
              danger: true,
              confirmLabel: t("platformServerHardDeleteNowButton"),
            });
            if (!ok) return;
            const res = await adminDeleteServer(srv.id, { hard_delete: true });
            if (res.success) {
              addToast("success", t("platformServerDeleteSuccess", { serverName: srv.name }));
              await refetchServers();
            } else {
              addToast("error", res.error ?? t("platformServerDeleteError"));
            }
          })();
        },
      });
    }

    return items;
  }

  async function handleSendDMOwner(srv: AdminServerListItem) {
    const channelId = await useDMStore.getState().createOrGetChannel(srv.owner_id);
    if (channelId) {
      useUIStore.getState().openTab(channelId, "dm", srv.owner_username);
      useSettingsStore.getState().closeSettings();
    }
  }

  async function handleDeleteConfirm(reason: string, hardDelete?: boolean) {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    const targetName = deleteTarget.name;
    setDeleteTarget(null);

    const body: { reason?: string; hard_delete?: boolean } = {};
    if (reason) body.reason = reason;
    if (hardDelete) body.hard_delete = true;

    const res = await adminDeleteServer(targetId, Object.keys(body).length ? body : undefined);
    if (res.success) {
      addToast("success", t("platformServerDeleteSuccess", { serverName: targetName }));
      await refetchServers();
    } else {
      addToast("error", res.error ?? t("platformServerDeleteError"));
    }
  }

  // ─── Sort indicator ───
  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return null;
    return (
      <span className="admin-server-sort-icon">
        {sortDir === "asc" ? "\u25B2" : "\u25BC"}
      </span>
    );
  }

  // ─── Render cell ───
  function renderCell(srv: AdminServerListItem, colKey: SortKey) {
    switch (colKey) {
      case "name":
        return (
          <div className="admin-server-name-cell">
            <div className="admin-server-icon">
              {srv.icon_url ? (
                <img src={resolveAssetUrl(srv.icon_url)} alt="" />
              ) : (
                srv.name.charAt(0).toUpperCase()
              )}
            </div>
            <span title={srv.name}>{srv.name}</span>
            {srv.deleted_at && (
              <span
                className="admin-user-banned-badge"
                style={{ background: "var(--color-text-danger, #f87171)" }}
                title={srv.deleted_by_admin ? `Deleted by admin at ${srv.deleted_at}` : `Soft-deleted at ${srv.deleted_at}`}
              >
                {t("deletedBadge", { ns: "common" })}
              </span>
            )}
          </div>
        );

      case "id":
        return (
          <span className="admin-server-id" title={srv.id}>
            {srv.id.slice(0, 8)}...
          </span>
        );

      case "owner_username":
        return srv.owner_username;

      case "created_at":
        return formatDate(srv.created_at);

      case "type":
        return (
          <span
            className={`admin-server-type-badge ${srv.is_platform_managed ? "managed" : "self"}`}
          >
            {srv.is_platform_managed
              ? t("platformServerTypeManaged")
              : t("platformServerTypeSelf")}
          </span>
        );

      case "member_count":
        return srv.member_count;

      case "channel_count":
        return srv.channel_count;

      case "message_count":
        return srv.message_count.toLocaleString();

      case "storage_mb":
        return formatStorage(srv.storage_mb);

      case "last_activity":
        return formatRelativeTime(srv.last_activity);

      case "instance": {
        if (!srv.is_platform_managed) {
          return (
            <span className="admin-server-type-badge self">
              {t("platformServerTypeSelf")}
            </span>
          );
        }

        const hasPending = pendingChanges[srv.id] !== undefined;
        const isSavingThis = savingServers.has(srv.id);
        const currentInstanceId = hasPending
          ? pendingChanges[srv.id]
          : (srv.livekit_instance_id ?? "");

        return (
          <div className="admin-server-instance-cell">
            <select
              className="admin-server-instance-select"
              value={currentInstanceId}
              onChange={(e) => handleInstanceChange(srv.id, e.target.value)}
              disabled={isSavingThis}
            >
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {instanceLabel(inst.id)}
                </option>
              ))}
            </select>
            {hasPending && (
              <>
                <button
                  className="admin-server-confirm-btn"
                  onClick={() => handleConfirm(srv.id)}
                  disabled={isSavingThis}
                  title={t("save")}
                >
                  {isSavingThis ? "..." : "\u2713"}
                </button>
                <button
                  className="admin-server-cancel-btn"
                  onClick={() => handleCancelChange(srv.id)}
                  disabled={isSavingThis}
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

  // ─── Render ───
  return (
    <div className="admin-server-list">
      {/* ── Toolbar: Search + Status filter ── */}
      <div className="admin-server-toolbar">
        <input
          className="admin-server-search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("platformServerSearchPlaceholder")}
        />
        <FilterDropdown
          label={t("platformFilterState")}
          options={[
            { value: "active", label: t("platformUserFilterActive") },
            { value: "soft_deleted", label: t("platformUserFilterSoftDeleted") },
          ]}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
        <FilterDropdown
          label={t("platformFilterType")}
          options={[
            { value: "managed", label: t("platformServerTypeManaged") },
            { value: "self", label: t("platformServerTypeSelf") },
          ]}
          selected={typeFilter}
          onChange={setTypeFilter}
        />
      </div>

      {/* ── Table ── */}
      {servers.length === 0 ? (
        <p className="no-channel">
          {isLoading
            ? t("loading")
            : total === 0
              ? t("platformServerNoServers")
              : t("platformServerNoResults")}
        </p>
      ) : (
        <div className={`admin-server-table-wrap${isLoading ? " is-loading" : ""}`}>
          <table className="admin-server-table">
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
                      className="admin-server-th-content"
                      style={{ justifyContent: col.align === "right" ? "flex-end" : "flex-start" }}
                    >
                      <span>{t(col.labelKey)}</span>
                      {sortIndicator(col.key)}
                    </div>
                    {/* Resize handle */}
                    <div
                      className="admin-server-resize-handle"
                      onMouseDown={(e) => handleResizeStart(e, col.key)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {servers.map((srv) => (
                <tr
                  key={srv.id}
                  onContextMenu={(e) => {
                    const items = buildContextItems(srv);
                    if (items.length > 0) openMenu(e, items);
                  }}
                >
                  {COLUMNS.map((col) => (
                    <td key={col.key} style={{ textAlign: col.align }}>
                      {renderCell(srv, col.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination ── */}
      <Pagination
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {/* Context Menu */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* Delete Dialog */}
      {deleteTarget && (
        <PlatformActionDialog
          title={t("platformServerDeleteTitle")}
          description={t("platformServerDeleteDescription", { serverName: deleteTarget.name })}
          reasonLabel={t("platformServerDeleteReasonLabel")}
          reasonPlaceholder={t("platformServerDeleteReasonPlaceholder")}
          confirmLabel={t("platformServerDeleteConfirm")}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          showHardDeleteToggle
          hardDeleteLabel={t("permanentDelete")}
        />
      )}
    </div>
  );
}

export default AdminServerList;
