import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useServerStore, toServerListItem } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { useDiscovery } from "../../hooks/useDiscovery";
import { joinPublicServer, type PublicServerListItem } from "../../api/discovery";
import { SERVER_CATEGORIES, categoryLabelKey } from "../../constants/serverCategories";
import DiscoveryServerCard, { type JoinStatus } from "./DiscoveryServerCard";
import ReportServerModal from "./ReportServerModal";

function DiscoveryOverlay() {
  const { t } = useTranslation("discovery");
  const { t: tSettings } = useTranslation("settings");
  const closeDiscovery = useUIStore((s) => s.closeDiscovery);
  const addToast = useToastStore((s) => s.addToast);

  const {
    category,
    setCategory,
    searchInput,
    setSearchInput,
    page,
    setPage,
    totalPages,
    items,
    featured,
    loading,
    showFeatured,
  } = useDiscovery();

  const [joinStatus, setJoinStatus] = useState<Record<string, JoinStatus>>({});
  const [reportTarget, setReportTarget] = useState<PublicServerListItem | null>(null);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDiscovery();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDiscovery]);

  async function handleJoin(item: PublicServerListItem) {
    if (joinStatus[item.id] || item.is_member) return;
    setJoinStatus((s) => ({ ...s, [item.id]: "joining" }));

    const res = await joinPublicServer(item.id);
    if (res.success && res.data) {
      if (res.data.pending) {
        setJoinStatus((s) => ({ ...s, [item.id]: "pending" }));
        addToast("info", t("requestSent"));
        return;
      }
      const server = res.data.server;
      if (server) {
        const store = useServerStore.getState();
        if (!store.servers.some((s) => s.id === server.id)) {
          useServerStore.setState((state) => ({
            servers: [...state.servers, toServerListItem(server)],
          }));
        }
        useServerStore.setState({ activeServerId: server.id, activeServer: server });
        addToast("success", t("joined"));
        closeDiscovery();
        return;
      }
    }
    setJoinStatus((s) => {
      const next = { ...s };
      delete next[item.id];
      return next;
    });
    addToast("error", res.error ?? t("joinError"));
  }

  const renderGrid = (list: PublicServerListItem[]) => (
    <div className="disc-grid">
      {list.map((item) => (
        <DiscoveryServerCard
          key={item.id}
          item={item}
          status={joinStatus[item.id] ?? "idle"}
          onJoin={handleJoin}
          onReport={setReportTarget}
        />
      ))}
    </div>
  );

  return createPortal(
    <div className="disc-overlay">
      {/* Header */}
      <div className="disc-header">
        <div className="disc-header-top">
          <h1 className="disc-title">{t("title")}</h1>
          <button className="disc-close" onClick={closeDiscovery} title={t("close")}>
            &#x2715;
          </button>
        </div>
        <p className="disc-subtitle">{t("subtitle")}</p>
        <div className="disc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="disc-search-input"
            autoFocus
          />
        </div>
      </div>

      {/* Category tabs */}
      <div className="disc-tabs">
        <button
          className={`disc-tab${category === "" ? " active" : ""}`}
          onClick={() => setCategory("")}
        >
          {t("allCategories")}
        </button>
        {SERVER_CATEGORIES.map((c) => (
          <button
            key={c}
            className={`disc-tab${category === c ? " active" : ""}`}
            onClick={() => setCategory(c)}
          >
            {tSettings(categoryLabelKey(c))}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="disc-content">
        {showFeatured && featured.length > 0 && (
          <section className="disc-section">
            <h2 className="disc-section-title">{t("featured")}</h2>
            {renderGrid(featured)}
          </section>
        )}

        <section className="disc-section">
          {(!showFeatured || featured.length === 0) ? null : (
            <h2 className="disc-section-title">{t("allServers")}</h2>
          )}

          {loading && items.length === 0 ? (
            <p className="disc-empty">{t("loading", { ns: "common" })}</p>
          ) : items.length === 0 ? (
            <p className="disc-empty">{t("empty")}</p>
          ) : (
            <>
              {renderGrid(items)}
              {totalPages > 1 && (
                <div className="disc-pagination">
                  <button
                    className="disc-page-btn"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    {t("prev")}
                  </button>
                  <span className="disc-page-info">{t("pageOf", { page, total: totalPages })}</span>
                  <button
                    className="disc-page-btn"
                    disabled={page >= totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    {t("next")}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {reportTarget && (
        <ReportServerModal
          serverId={reportTarget.id}
          serverName={reportTarget.name}
          onClose={() => setReportTarget(null)}
        />
      )}
    </div>,
    document.body
  );
}

export default DiscoveryOverlay;
