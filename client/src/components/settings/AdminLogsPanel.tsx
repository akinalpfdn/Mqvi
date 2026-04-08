/**
 * AdminLogsPanel — Platform admin structured log viewer.
 * Shows voice/video/WS/auth errors stored in app_logs table.
 * Filter by category, level, search text. Paginated. Clear all button.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import { listAppLogs, clearAppLogs } from "../../api/admin";
import type { AppLog, AppLogLevel } from "../../types";

const PAGE_SIZE = 50;

const LEVEL_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "", labelKey: "platformLogsAllLevels" },
  { value: "error", labelKey: "platformLogsLevelError" },
  { value: "warn", labelKey: "platformLogsLevelWarn" },
  { value: "info", labelKey: "platformLogsLevelInfo" },
];

const CATEGORY_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "", labelKey: "platformLogsAllCategories" },
  { value: "voice", labelKey: "platformLogsCategoryVoice" },
  { value: "livekit", labelKey: "platformLogsCategoryLiveKit" },
  { value: "video", labelKey: "platformLogsCategoryVideo" },
  { value: "screen_share", labelKey: "platformLogsCategoryScreenShare" },
  { value: "ws", labelKey: "platformLogsCategoryWs" },
  { value: "auth", labelKey: "platformLogsCategoryAuth" },
  { value: "general", labelKey: "platformLogsCategoryGeneral" },
  { value: "feedback", labelKey: "platformLogsCategoryFeedback" },
];

function levelBadgeClass(level: AppLogLevel): string {
  switch (level) {
    case "error":
      return "log-badge log-badge-error";
    case "warn":
      return "log-badge log-badge-warn";
    case "info":
      return "log-badge log-badge-info";
    default:
      return "log-badge";
  }
}

/** Parse backend SQLite timestamps as UTC. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return d.toLocaleString();
}

function parseMetadata(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function AdminLogsPanel() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const [logs, setLogs] = useState<AppLog[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(0);

  // Filters
  const [level, setLevel] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Expanded rows for metadata
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const fetchLogs = useCallback(
    async (p = 0, lvl = level, cat = category, s = search) => {
      try {
        setIsLoading(true);
        const res = await listAppLogs({
          level: lvl || undefined,
          category: cat || undefined,
          search: s || undefined,
          limit: PAGE_SIZE,
          offset: p * PAGE_SIZE,
        });
        if (res.success && res.data) {
          setLogs(res.data.logs ?? []);
          setTotal(res.data.total);
        } else {
          addToast("error", res.error ?? t("platformLogsLoadError"));
        }
      } catch {
        addToast("error", t("platformLogsLoadError"));
      } finally {
        setIsLoading(false);
      }
    },
    [level, category, search, addToast, t]
  );

  useEffect(() => {
    fetchLogs(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFilterChange(newLevel: string, newCategory: string) {
    setLevel(newLevel);
    setCategory(newCategory);
    setPage(0);
    setExpandedIds(new Set());
    fetchLogs(0, newLevel, newCategory, search);
  }

  function handleSearchChange(value: string) {
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setPage(0);
      setExpandedIds(new Set());
      fetchLogs(0, level, category, value);
    }, 400);
  }

  function handlePageChange(newPage: number) {
    setPage(newPage);
    setExpandedIds(new Set());
    fetchLogs(newPage);
  }

  async function handleClear() {
    const ok = await confirm({
      message: t("platformLogsClearConfirm"),
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await clearAppLogs();
      if (res.success) {
        setLogs([]);
        setTotal(0);
        setPage(0);
        addToast("success", t("platformLogsCleared"));
      } else {
        addToast("error", res.error ?? t("platformLogsClearError"));
      }
    } catch {
      addToast("error", t("platformLogsClearError"));
    }
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="admin-logs-panel">
      {/* Header */}
      <div className="admin-logs-header">
        <h2 className="settings-section-title">{t("platformLogsTitle")}</h2>
        <button
          className="settings-btn settings-btn-danger"
          onClick={handleClear}
          disabled={total === 0}
        >
          {t("platformLogsClearAll")}
        </button>
      </div>

      {/* Filters */}
      <div className="admin-logs-filters">
        <select
          className="admin-logs-select"
          value={level}
          onChange={(e) => handleFilterChange(e.target.value, category)}
        >
          {LEVEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>

        <select
          className="admin-logs-select"
          value={category}
          onChange={(e) => handleFilterChange(level, e.target.value)}
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>

        <input
          type="text"
          className="admin-logs-search"
          placeholder={t("platformLogsSearchPlaceholder")}
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
      </div>

      {/* Log list */}
      <div className="admin-logs-list">
        {isLoading && <p className="no-channel">{t("loading")}</p>}

        {!isLoading && logs.length === 0 && (
          <p className="no-channel">{t("platformLogsEmpty")}</p>
        )}

        {!isLoading &&
          logs.map((log) => {
            const meta = parseMetadata(log.metadata);
            const isExpanded = expandedIds.has(log.id);

            return (
              <div
                key={log.id}
                className={`admin-log-entry${isExpanded ? " expanded" : ""}`}
                onClick={() => meta && toggleExpand(log.id)}
                style={{ cursor: meta ? "pointer" : "default" }}
              >
                <div className="admin-log-row">
                  <span className={levelBadgeClass(log.level)}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="admin-log-category">{log.category}</span>
                  {log.user_id && (
                    <span className="admin-log-user" title={log.user_id}>
                      {log.display_name || log.username || log.user_id.slice(0, 8)}
                    </span>
                  )}
                  <span className="admin-log-message">{log.message}</span>
                  <span className="admin-log-time">
                    {formatTimestamp(log.created_at)}
                  </span>
                </div>

                {isExpanded && meta && (
                  <div className="admin-log-metadata">
                    {Object.entries(meta).map(([key, value]) => (
                      <div key={key} className="admin-log-meta-item">
                        <span className="admin-log-meta-key">{key}:</span>
                        <span className="admin-log-meta-value">{value}</span>
                      </div>
                    ))}
                    {log.user_id && (
                      <div className="admin-log-meta-item">
                        <span className="admin-log-meta-key">user_id:</span>
                        <span className="admin-log-meta-value">{log.user_id}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="admin-logs-pagination">
          <button
            className="settings-btn"
            disabled={page === 0}
            onClick={() => handlePageChange(page - 1)}
          >
            ‹
          </button>
          <span className="admin-logs-page-info">
            {t("platformLogsPage", { current: page + 1, total: totalPages })}
          </span>
          <button
            className="settings-btn"
            disabled={page >= totalPages - 1}
            onClick={() => handlePageChange(page + 1)}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}

export default AdminLogsPanel;
