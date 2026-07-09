/** AdminUserList — Platform admin user management table (sortable, filterable, resizable columns). */

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { listAdminUsers, platformBanUser, platformUnbanUser, hardDeleteUser, setUserPlatformAdmin, setUserQuota } from "../../api/admin";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useConfirm } from "../../hooks/useConfirm";
import ContextMenu from "../shared/ContextMenu";
import Pagination from "../shared/Pagination";
import FilterDropdown from "../shared/FilterDropdown";
import PlatformBanDialog from "./PlatformBanDialog";
import PlatformActionDialog from "./PlatformActionDialog";
import BadgeAssignModal from "../members/BadgeAssignModal";
import type { AdminUserListItem } from "../../types";
import { resolveAssetUrl } from "../../utils/constants";
import type { ContextMenuItem } from "../../hooks/useContextMenu";

const BADGE_ADMIN_USER_ID = "95a8b295072f98a5";

// ─── Column Definition ───

type SortKey =
  | "username"
  | "display_name"
  | "id"
  | "created_at"
  | "status"
  | "is_platform_admin"
  | "last_activity"
  | "message_count"
  | "storage_mb"
  | "quota_bytes"
  | "owned_self_servers"
  | "owned_mqvi_servers"
  | "member_server_count"
  | "ban_count";

type ColumnDef = {
  key: SortKey;
  labelKey: string;
  defaultWidth: number;
  minWidth: number;
  sortable: boolean;
  align: "left" | "center" | "right";
};

const COLUMNS: ColumnDef[] = [
  { key: "username", labelKey: "platformUserUsername", defaultWidth: 150, minWidth: 100, sortable: true, align: "left" },
  { key: "display_name", labelKey: "platformUserDisplayName", defaultWidth: 140, minWidth: 100, sortable: true, align: "left" },
  { key: "id", labelKey: "platformUserID", defaultWidth: 110, minWidth: 80, sortable: false, align: "left" },
  { key: "created_at", labelKey: "platformUserJoined", defaultWidth: 155, minWidth: 120, sortable: true, align: "left" },
  { key: "status", labelKey: "platformUserStatus", defaultWidth: 90, minWidth: 70, sortable: true, align: "left" },
  { key: "is_platform_admin", labelKey: "platformUserAdmin", defaultWidth: 80, minWidth: 60, sortable: true, align: "center" },
  { key: "last_activity", labelKey: "platformUserLastActivity", defaultWidth: 110, minWidth: 80, sortable: true, align: "left" },
  { key: "message_count", labelKey: "platformUserMessages", defaultWidth: 90, minWidth: 70, sortable: true, align: "right" },
  { key: "storage_mb", labelKey: "platformUserStorage", defaultWidth: 85, minWidth: 65, sortable: true, align: "right" },
  { key: "quota_bytes", labelKey: "platformUserQuota", defaultWidth: 90, minWidth: 70, sortable: true, align: "right" },
  { key: "owned_self_servers", labelKey: "platformUserSelfServers", defaultWidth: 100, minWidth: 70, sortable: true, align: "right" },
  { key: "owned_mqvi_servers", labelKey: "platformUserMqviServers", defaultWidth: 100, minWidth: 70, sortable: true, align: "right" },
  { key: "member_server_count", labelKey: "platformUserMemberServers", defaultWidth: 100, minWidth: 70, sortable: true, align: "right" },
  { key: "ban_count", labelKey: "platformUserBans", defaultWidth: 70, minWidth: 55, sortable: true, align: "right" },
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

// ─── Component ───

function AdminUserList() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const addToast = useToastStore((s) => s.addToast);
  const currentUser = useAuthStore((s) => s.user);
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const confirm = useConfirm();
  const isBadgeAdmin = currentUser?.id === BADGE_ADMIN_USER_ID;

  // ─── Data state ───
  const [users, setUsers] = useState<AdminUserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Pagination ───
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // ─── Ban dialog state ───
  const [banTarget, setBanTarget] = useState<AdminUserListItem | null>(null);

  // ─── Badge assign state ───
  const [badgeTarget, setBadgeTarget] = useState<AdminUserListItem | null>(null);

  // ─── Delete dialog state ───
  const [deleteTarget, setDeleteTarget] = useState<AdminUserListItem | null>(null);

  // ─── Quota edit state ───
  const [quotaTarget, setQuotaTarget] = useState<AdminUserListItem | null>(null);
  const [quotaInputGB, setQuotaInputGB] = useState("");

  // ─── Table state ───
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Multi-select filters — combine with AND across dimensions, OR within. Empty = all.
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [presenceFilter, setPresenceFilter] = useState<string[]>([]);
  const [adminFilter, setAdminFilter] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(getDefaultWidths);

  // Debounce search input — fires backend fetch 300ms after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ─── Column resize refs ───
  const resizingRef = useRef<{
    col: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const widthsRef = useRef(columnWidths);
  widthsRef.current = columnWidths;

  // ─── Fetch (server-side filter/sort/paging) ───
  // Mutating actions (ban/delete/quota) bump this to force a refetch with current params.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      const res = await listAdminUsers({
        limit: pageSize,
        offset: page * pageSize,
        search: debouncedSearch || undefined,
        statuses: statusFilter,
        presences: presenceFilter,
        admin: adminFilter,
        sort: sortKey,
        dir: sortDir,
      });
      if (cancelled) return;
      if (res.success && res.data) {
        // Last user on the last page got deleted — backend returns items=[] but total>0.
        // Clamp page and let the next render refetch.
        if ((res.data.items?.length ?? 0) === 0 && res.data.total > 0 && page > 0) {
          const lastPage = Math.max(0, Math.ceil(res.data.total / pageSize) - 1);
          setPage(lastPage);
          return;
        }
        setUsers(res.data.items ?? []);
        setTotal(res.data.total);
      } else {
        addToast("error", res.error ?? t("platformUserLoadError"));
      }
      setIsLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [page, pageSize, debouncedSearch, statusFilter, presenceFilter, adminFilter, sortKey, sortDir, refetchTick, addToast, t]);

  // Reset to page 0 whenever the underlying filter/sort/page-size changes —
  // staying on page N after a filter narrows results would yield an empty page.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, statusFilter, presenceFilter, adminFilter, sortKey, sortDir, pageSize]);

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

  // ─── Context Menu ───

  const refetchUsers = useCallback(() => {
    setRefetchTick((n) => n + 1);
  }, []);

  function buildContextItems(user: AdminUserListItem): ContextMenuItem[] {
    const isMe = user.id === currentUser?.id;
    const items: ContextMenuItem[] = [];

    if (!isMe) {
      items.push({
        label: t("platformUserSendDM"),
        onClick: () => handleSendDM(user),
      });
    }

    if (isBadgeAdmin) {
      items.push({
        label: tCommon("assignBadge"),
        separator: items.length > 0,
        onClick: () => setBadgeTarget(user),
      });
    }

    if (!isMe) {
      items.push({
        label: user.is_platform_admin
          ? t("platformUserRemoveAdmin")
          : t("platformUserMakeAdmin"),
        separator: items.length > 0,
        onClick: () => handleAdminToggle(user),
      });
    }

    items.push({
      label: t("platformUserSetQuota"),
      separator: items.length > 0,
      onClick: () => openQuotaEdit(user),
    });

    if (!isMe && !user.is_platform_banned) {
      items.push({
        label: t("platformUserBan"),
        danger: true,
        separator: items.length > 0,
        onClick: () => setBanTarget(user),
      });
    }

    if (!isMe && user.is_platform_banned) {
      items.push({
        label: t("platformUserUnban"),
        separator: items.length > 0,
        onClick: () => handleUnban(user),
      });
    }

    if (!isMe && !user.deleted_at) {
      items.push({
        label: t("platformUserDelete"),
        danger: true,
        separator: items.length > 0 && !items[items.length - 1]?.separator,
        onClick: () => setDeleteTarget(user),
      });
    }

    if (!isMe && user.deleted_at && !user.is_hard_deleted) {
      items.push({
        label: t("restore"),
        separator: items.length > 0 && !items[items.length - 1]?.separator,
        onClick: () => {
          void (async () => {
            const res = await import("../../api/admin").then((m) => m.adminRestoreUser(user.id));
            if (res.success) {
              addToast("success", t("restoreServerSuccess")); // reuse restore success key
              await refetchUsers();
            } else {
              addToast("error", res.error ?? t("restoreServerFailed"));
            }
          })();
        },
      });
      // A soft-deleted user is otherwise stuck waiting for the 30-day TTL.
      // Admins need a way to skip the wait — "delete now" maps to the existing
      // hard-delete API path with hard_delete=true.
      items.push({
        label: t("platformUserHardDeleteNow"),
        danger: true,
        onClick: () => {
          void (async () => {
            const ok = await confirm({
              title: t("platformUserHardDeleteNowTitle"),
              message: t("platformUserHardDeleteNowConfirm", { username: user.username }),
              danger: true,
              confirmLabel: t("platformUserHardDeleteNowButton"),
            });
            if (!ok) return;
            const res = await hardDeleteUser(user.id, { hard_delete: true });
            if (res.success) {
              addToast("success", t("platformDeleteSuccess", { username: user.username }));
              await refetchUsers();
            } else {
              addToast("error", res.error ?? t("platformDeleteError"));
            }
          })();
        },
      });
    }

    return items;
  }

  async function handleSendDM(user: AdminUserListItem) {
    const channelId = await useDMStore.getState().createOrGetChannel(user.id);
    if (channelId) {
      const displayName = user.display_name ?? user.username;
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
      await refetchUsers();
    } else {
      addToast("error", res.error ?? t("platformBanError"));
    }
  }

  async function handleUnban(user: AdminUserListItem) {
    const ok = await confirm({
      message: t("platformUnbanConfirm", { username: user.username }),
    });
    if (!ok) return;

    const res = await platformUnbanUser(user.id);
    if (res.success) {
      addToast("success", t("platformUnbanSuccess", { username: user.username }));
      await refetchUsers();
    } else {
      addToast("error", res.error ?? t("platformUnbanError"));
    }
  }

  async function handleAdminToggle(user: AdminUserListItem) {
    const willBeAdmin = !user.is_platform_admin;
    const message = willBeAdmin
      ? t("platformMakeAdminConfirm", { username: user.username })
      : t("platformRemoveAdminConfirm", { username: user.username });

    const ok = await confirm({ message, danger: !willBeAdmin });
    if (!ok) return;

    const res = await setUserPlatformAdmin(user.id, { is_admin: willBeAdmin });
    if (res.success) {
      addToast("success", t("platformAdminSuccess"));
      await refetchUsers();
    } else {
      addToast("error", res.error ?? t("platformAdminError"));
    }
  }

  function openQuotaEdit(user: AdminUserListItem) {
    setQuotaTarget(user);
    setQuotaInputGB((user.quota_bytes / (1024 * 1024 * 1024)).toFixed(1));
  }

  async function handleQuotaConfirm() {
    if (!quotaTarget) return;
    const gb = parseFloat(quotaInputGB);
    if (isNaN(gb) || gb <= 0) {
      addToast("error", t("platformQuotaInvalid"));
      return;
    }
    const bytes = Math.round(gb * 1024 * 1024 * 1024);
    const res = await setUserQuota(quotaTarget.id, bytes);
    if (res.success) {
      addToast("success", t("platformQuotaSuccess", { username: quotaTarget.username }));
      setQuotaTarget(null);
      await refetchUsers();
    } else {
      addToast("error", res.error ?? t("platformQuotaError"));
    }
  }

  async function handleDeleteConfirm(reason: string, hardDelete?: boolean) {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    const targetName = deleteTarget.username;
    setDeleteTarget(null);

    const body: { reason?: string; hard_delete?: boolean } = {};
    if (reason) body.reason = reason;
    if (hardDelete) body.hard_delete = true;

    const res = await hardDeleteUser(targetId, Object.keys(body).length ? body : undefined);
    if (res.success) {
      addToast("success", t("platformDeleteSuccess", { username: targetName }));
      await refetchUsers();
    } else {
      addToast("error", res.error ?? t("platformDeleteError"));
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

  // ─── Helpers ───

  function formatDateTime(iso: string) {
    try {
      return new Date(iso).toLocaleString(undefined, {
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

  function formatRelativeTime(iso: string | null) {
    if (!iso) return t("platformUserNever");
    try {
      const diff = Date.now() - parseUTC(iso);
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return t("platformUserJustNow");
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days}d`;
      return formatDateTime(iso);
    } catch {
      return iso ?? "";
    }
  }

  function formatQuota(bytes: number) {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
    return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
  }

  function formatStorage(mb: number) {
    if (mb < 0.01) return "0 MB";
    if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
  }

  // ─── Sort indicator ───
  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return null;
    return (
      <span className="admin-user-sort-icon">
        {sortDir === "asc" ? "\u25B2" : "\u25BC"}
      </span>
    );
  }

  // ─── Status badge ───
  function statusBadge(status: string) {
    const statusMap: Record<string, string> = {
      online: "platformUserStatusOnline",
      idle: "platformUserStatusIdle",
      dnd: "platformUserStatusDND",
      offline: "platformUserStatusOffline",
    };
    const labelKey = statusMap[status] ?? "platformUserStatusOffline";
    return (
      <span className={`admin-user-status-badge ${status}`}>
        {t(labelKey)}
      </span>
    );
  }

  // ─── Render cell ───
  function renderCell(user: AdminUserListItem, colKey: SortKey) {
    switch (colKey) {
      case "username":
        return (
          <div className="admin-user-name-cell">
            <div className="admin-user-avatar">
              {user.avatar_url ? (
                <img src={resolveAssetUrl(user.avatar_url)} alt="" />
              ) : (
                user.username.charAt(0).toUpperCase()
              )}
            </div>
            <span title={user.username}>{user.username}</span>
            {user.is_platform_banned && (
              <span className="admin-user-banned-badge">{t("platformUserBannedBadge")}</span>
            )}
            {user.deleted_at && user.is_hard_deleted && (
              <span
                className="admin-user-tombstone-badge"
                title={t("platformUserTombstoneTitle")}
              >
                {t("platformUserTombstoneBadge")}
              </span>
            )}
            {user.deleted_at && !user.is_hard_deleted && (
              <span
                className="admin-user-deleted-badge"
                title={t("platformUserSoftDeletedTitle", { date: user.deleted_at })}
              >
                {t("platformUserSoftDeletedBadge")}
              </span>
            )}
          </div>
        );

      case "display_name":
        return (
          <span className="admin-user-display-name" title={user.display_name ?? ""}>
            {user.display_name ?? "\u2014"}
          </span>
        );

      case "id":
        return (
          <span className="admin-user-id" title={user.id}>
            {user.id.slice(0, 8)}...
          </span>
        );

      case "created_at":
        return formatDateTime(user.created_at);

      case "status":
        return statusBadge(user.status);

      case "is_platform_admin":
        return user.is_platform_admin ? (
          <span className="admin-user-admin-badge">{t("platformUserAdminYes")}</span>
        ) : (
          <span className="admin-user-text-muted">\u2014</span>
        );

      case "last_activity":
        return formatRelativeTime(user.last_activity);

      case "message_count":
        return user.message_count.toLocaleString();

      case "storage_mb":
        return formatStorage(user.storage_mb);

      case "quota_bytes":
        return formatQuota(user.quota_bytes);

      case "owned_self_servers":
        return user.owned_self_servers;

      case "owned_mqvi_servers":
        return user.owned_mqvi_servers;

      case "member_server_count":
        return user.member_server_count;

      case "ban_count":
        return user.ban_count > 0 ? (
          <span className="admin-user-ban-count">{user.ban_count}</span>
        ) : (
          <span className="admin-user-text-muted">0</span>
        );

      default:
        return null;
    }
  }

  // ─── Render ───
  return (
    <div className="admin-user-list">
      {/* ── Toolbar: Search + Status filter + Count ── */}
      <div className="admin-user-toolbar">
        <input
          className="admin-user-search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("platformUserSearchPlaceholder")}
        />
        <FilterDropdown
          label={t("platformFilterState")}
          options={[
            { value: "active", label: t("platformUserFilterActive") },
            { value: "banned", label: t("platformUserFilterBanned") },
            { value: "soft_deleted", label: t("platformUserFilterSoftDeleted") },
            { value: "tombstone", label: t("platformUserFilterTombstone") },
          ]}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
        <FilterDropdown
          label={t("platformFilterPresence")}
          options={[
            { value: "online", label: t("platformUserStatusOnline") },
            { value: "idle", label: t("platformUserStatusIdle") },
            { value: "dnd", label: t("platformUserStatusDND") },
            { value: "offline", label: t("platformUserStatusOffline") },
          ]}
          selected={presenceFilter}
          onChange={setPresenceFilter}
        />
        <FilterDropdown
          label={t("platformFilterAdmin")}
          options={[
            { value: "admin", label: t("platformFilterAdminYes") },
            { value: "non_admin", label: t("platformFilterAdminNo") },
          ]}
          selected={adminFilter}
          onChange={setAdminFilter}
        />
      </div>

      {/* ── Table ── */}
      {users.length === 0 ? (
        <p className="no-channel">
          {isLoading
            ? t("loading")
            : total === 0
              ? t("platformUserNoUsers")
              : t("platformUserNoResults")}
        </p>
      ) : (
        <div className={`admin-user-table-wrap${isLoading ? " is-loading" : ""}`}>
          <table className="admin-user-table">
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
                      className="admin-user-th-content"
                      style={{ justifyContent: col.align === "right" ? "flex-end" : col.align === "center" ? "center" : "flex-start" }}
                    >
                      <span>{t(col.labelKey)}</span>
                      {sortIndicator(col.key)}
                    </div>
                    {/* Resize handle */}
                    <div
                      className="admin-user-resize-handle"
                      onMouseDown={(e) => handleResizeStart(e, col.key)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr
                  key={user.id}
                  className={user.is_platform_banned ? "admin-user-row-banned" : ""}
                  onContextMenu={(e) => {
                    const items = buildContextItems(user);
                    if (items.length > 0) openMenu(e, items);
                  }}
                >
                  {COLUMNS.map((col) => (
                    <td key={col.key} style={{ textAlign: col.align }}>
                      {renderCell(user, col.key)}
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
          showHardDeleteToggle
          hardDeleteLabel={t("permanentDelete")}
          hardDeleteHint={t("platformDeleteHardHint")}
        />
      )}

      {/* Quota Edit Dialog */}
      {quotaTarget && (
        <div className="modal-overlay" onClick={() => setQuotaTarget(null)}>
          <div className="modal-content modal-sm" onClick={(e) => e.stopPropagation()}>
            <h3>{t("platformQuotaTitle", { username: quotaTarget.username })}</h3>
            <p className="modal-description">
              {t("platformQuotaCurrent")}: {formatStorage(quotaTarget.storage_mb)} / {formatQuota(quotaTarget.quota_bytes)}
            </p>
            <div className="form-group">
              <label>{t("platformQuotaLabel")}</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="number"
                  className="form-input"
                  value={quotaInputGB}
                  onChange={(e) => setQuotaInputGB(e.target.value)}
                  min="0.1"
                  step="0.1"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleQuotaConfirm(); }}
                />
                <span>GB</span>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setQuotaTarget(null)}>
                {tCommon("cancel")}
              </button>
              <button className="btn btn-primary" onClick={handleQuotaConfirm}>
                {tCommon("save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Badge Assign Modal */}
      {badgeTarget && (
        <BadgeAssignModal
          member={{
            id: badgeTarget.id,
            username: badgeTarget.username,
            display_name: badgeTarget.display_name,
            avatar_url: badgeTarget.avatar_url,
            status: badgeTarget.status as "online" | "idle" | "dnd" | "offline",
            custom_status: null,
            created_at: badgeTarget.created_at,
            roles: [],
            effective_permissions: 0,
          }}
          onClose={() => setBadgeTarget(null)}
        />
      )}
    </div>
  );
}

export default AdminUserList;
