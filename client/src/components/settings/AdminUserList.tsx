/**
 * AdminUserList — Platform admin kullanıcı yönetim tablosu.
 *
 * Özellikler:
 * - Sıralama: Sütun başlığına tıkla → asc/desc toggle
 * - Filtreleme: Arama çubuğu ile username, display name, ID filtrele
 * - Sütun genişliği: Sütun kenarını sürükleyerek ayarla
 *
 * Sadece is_platform_admin = true olan kullanıcılara görünür.
 * Backend PlatformAdminMiddleware ile korunur.
 */

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { listAdminUsers } from "../../api/admin";
import type { AdminUserListItem } from "../../types";

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

// ─── Sort comparator ───

function compareSortValue(
  a: AdminUserListItem,
  b: AdminUserListItem,
  key: SortKey,
  dir: "asc" | "desc",
): number {
  let result = 0;

  switch (key) {
    case "username":
      result = a.username.localeCompare(b.username);
      break;
    case "display_name": {
      const aName = a.display_name ?? "";
      const bName = b.display_name ?? "";
      result = aName.localeCompare(bName);
      break;
    }
    case "created_at":
      result = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      break;
    case "status":
      result = a.status.localeCompare(b.status);
      break;
    case "is_platform_admin":
      result = (a.is_platform_admin ? 1 : 0) - (b.is_platform_admin ? 1 : 0);
      break;
    case "last_activity": {
      const aTime = a.last_activity ? new Date(a.last_activity).getTime() : 0;
      const bTime = b.last_activity ? new Date(b.last_activity).getTime() : 0;
      result = aTime - bTime;
      break;
    }
    case "message_count":
      result = a.message_count - b.message_count;
      break;
    case "storage_mb":
      result = a.storage_mb - b.storage_mb;
      break;
    case "owned_self_servers":
      result = a.owned_self_servers - b.owned_self_servers;
      break;
    case "owned_mqvi_servers":
      result = a.owned_mqvi_servers - b.owned_mqvi_servers;
      break;
    case "member_server_count":
      result = a.member_server_count - b.member_server_count;
      break;
    case "ban_count":
      result = a.ban_count - b.ban_count;
      break;
    default:
      result = 0;
  }

  return dir === "desc" ? -result : result;
}

// ─── Component ───

function AdminUserList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  // ─── Data state ───
  const [users, setUsers] = useState<AdminUserListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Table state ───
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("username");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(getDefaultWidths);

  // ─── Column resize refs ───
  const resizingRef = useRef<{
    col: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const widthsRef = useRef(columnWidths);
  widthsRef.current = columnWidths;

  // ─── Fetch ───
  useEffect(() => {
    async function load() {
      setIsLoading(true);
      const res = await listAdminUsers();
      if (res.success && res.data) {
        setUsers(res.data);
      } else {
        addToast("error", res.error ?? t("platformUserLoadError"));
      }
      setIsLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Filtered + Sorted data ───
  const filteredUsers = useMemo(() => {
    let list = users;

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (u) =>
          u.username.toLowerCase().includes(q) ||
          u.id.toLowerCase().includes(q) ||
          (u.display_name?.toLowerCase().includes(q) ?? false),
      );
    }

    return [...list].sort((a, b) => compareSortValue(a, b, sortKey, sortDir));
  }, [users, searchQuery, sortKey, sortDir]);

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

  // ─── Helpers ───

  /** Tarih + saat formatı — kullanıcı özellikle saatlerin de gelmesini istedi */
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
      const diff = Date.now() - new Date(iso).getTime();
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
                <img src={user.avatar_url} alt="" />
              ) : (
                user.username.charAt(0).toUpperCase()
              )}
            </div>
            <span title={user.username}>{user.username}</span>
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
  if (isLoading) {
    return (
      <div className="admin-user-list">
        <p className="no-channel">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="admin-user-list">
      {/* ── Toolbar: Search + Count ── */}
      <div className="admin-user-toolbar">
        <input
          className="admin-user-search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("platformUserSearchPlaceholder")}
        />
        <span className="admin-user-count">
          {filteredUsers.length} / {users.length}
        </span>
      </div>

      {/* ── Table ── */}
      {filteredUsers.length === 0 ? (
        <p className="no-channel">
          {users.length === 0
            ? t("platformUserNoUsers")
            : t("platformUserNoResults")}
        </p>
      ) : (
        <div className="admin-user-table-wrap">
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
              {filteredUsers.map((user) => (
                <tr key={user.id}>
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
    </div>
  );
}

export default AdminUserList;
