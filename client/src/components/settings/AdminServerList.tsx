/**
 * AdminServerList — Platform admin sunucu yönetim tablosu.
 *
 * Özellikler:
 * - Sıralama: Sütun başlığına tıkla → asc/desc toggle
 * - Filtreleme: Arama çubuğu ile sunucu adı, ID, kurucu filtrele
 * - Sütun genişliği: Sütun kenarını sürükleyerek ayarla
 * - LiveKit instance migration: Dropdown + onay butonu
 *
 * Sadece is_platform_admin = true olan kullanıcılara görünür.
 * Backend PlatformAdminMiddleware ile korunur.
 */

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import {
  listLiveKitInstances,
  listAdminServers,
  migrateServerInstance,
} from "../../api/admin";
import type { LiveKitInstanceAdmin, AdminServerListItem } from "../../types";

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

// ─── Sort comparator ───

function compareSortValue(
  a: AdminServerListItem,
  b: AdminServerListItem,
  key: SortKey,
  dir: "asc" | "desc",
): number {
  let result = 0;

  switch (key) {
    case "name":
      result = a.name.localeCompare(b.name);
      break;
    case "owner_username":
      result = a.owner_username.localeCompare(b.owner_username);
      break;
    case "created_at":
      result = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      break;
    case "type":
      result = (a.is_platform_managed ? 1 : 0) - (b.is_platform_managed ? 1 : 0);
      break;
    case "member_count":
      result = a.member_count - b.member_count;
      break;
    case "channel_count":
      result = a.channel_count - b.channel_count;
      break;
    case "message_count":
      result = a.message_count - b.message_count;
      break;
    case "storage_mb":
      result = a.storage_mb - b.storage_mb;
      break;
    case "last_activity": {
      const aTime = a.last_activity ? new Date(a.last_activity).getTime() : 0;
      const bTime = b.last_activity ? new Date(b.last_activity).getTime() : 0;
      result = aTime - bTime;
      break;
    }
    default:
      result = 0;
  }

  return dir === "desc" ? -result : result;
}

// ─── Component ───

function AdminServerList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  // ─── Data state ───
  const [servers, setServers] = useState<AdminServerListItem[]>([]);
  const [instances, setInstances] = useState<LiveKitInstanceAdmin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Table state ───
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(getDefaultWidths);

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

  // ─── Fetch ───
  useEffect(() => {
    async function load() {
      setIsLoading(true);
      const [srvRes, instRes] = await Promise.all([
        listAdminServers(),
        listLiveKitInstances(),
      ]);
      if (srvRes.success && srvRes.data) setServers(srvRes.data);
      else addToast("error", srvRes.error ?? t("platformServerLoadError"));

      if (instRes.success && instRes.data) setInstances(instRes.data);
      setIsLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Filtered + Sorted data ───
  const filteredServers = useMemo(() => {
    let list = servers;

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.owner_username.toLowerCase().includes(q),
      );
    }

    return [...list].sort((a, b) => compareSortValue(a, b, sortKey, sortDir));
  }, [servers, searchQuery, sortKey, sortDir]);

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
      const diff = Date.now() - new Date(iso).getTime();
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
                <img src={srv.icon_url} alt="" />
              ) : (
                srv.name.charAt(0).toUpperCase()
              )}
            </div>
            <span title={srv.name}>{srv.name}</span>
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
              <button
                className="admin-server-confirm-btn"
                onClick={() => handleConfirm(srv.id)}
                disabled={isSavingThis}
                title={t("save")}
              >
                {isSavingThis ? "..." : "\u2713"}
              </button>
            )}
          </div>
        );
      }

      default:
        return null;
    }
  }

  // ─── Render ───
  if (isLoading) {
    return (
      <div className="admin-server-list">
        <p className="no-channel">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="admin-server-list">
      {/* ── Toolbar: Search + Count ── */}
      <div className="admin-server-toolbar">
        <input
          className="admin-server-search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("platformServerSearchPlaceholder")}
        />
        <span className="admin-server-count">
          {filteredServers.length} / {servers.length}
        </span>
      </div>

      {/* ── Table ── */}
      {filteredServers.length === 0 ? (
        <p className="no-channel">
          {servers.length === 0
            ? t("platformServerNoServers")
            : t("platformServerNoResults")}
        </p>
      ) : (
        <div className="admin-server-table-wrap">
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
              {filteredServers.map((srv) => (
                <tr key={srv.id}>
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
    </div>
  );
}

export default AdminServerList;
