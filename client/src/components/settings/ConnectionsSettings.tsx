/**
 * ConnectionsSettings — Backend server connection management (Electron-only).
 * Saved connections stored in localStorage. Switching triggers a reload
 * since SERVER_URL is computed at module level.
 */

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import { SERVER_URL } from "../../utils/constants";

// ─── Types ───

type SavedConnection = {
  id: string;
  name: string;
  url: string;
};

// ─── localStorage helpers ───

const CONNECTIONS_STORAGE_KEY = "mqvi_connections";
const ACTIVE_URL_KEY = "mqvi_server_url";

/** Default connection URL from env or hardcoded fallback (skips localStorage). */
function getDefaultUrl(): string {
  const envUrl = import.meta.env.VITE_SERVER_URL;
  if (envUrl) return (envUrl as string).replace(/\/$/, "");
  return "https://mqvi.net";
}

function loadConnections(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(CONNECTIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function saveConnections(connections: SavedConnection[]): void {
  try {
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
  } catch {}
}

/** Check if the given URL is the currently active connection. */
function isActiveUrl(url: string): boolean {
  return url.replace(/\/$/, "") === SERVER_URL;
}

// ─── Component ───

function ConnectionsSettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const defaultUrl = getDefaultUrl();

  // ─── State ───
  const [connections, setConnections] = useState<SavedConnection[]>(loadConnections);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");

  // ─── Validation ───

  function isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  // ─── Handlers ───

  const handleAdd = useCallback(() => {
    setIsAdding(true);
    setEditingId(null);
    setFormName("");
    setFormUrl("");
  }, []);

  const handleEdit = useCallback((conn: SavedConnection) => {
    setEditingId(conn.id);
    setIsAdding(false);
    setFormName(conn.name);
    setFormUrl(conn.url);
  }, []);

  const handleCancelForm = useCallback(() => {
    setIsAdding(false);
    setEditingId(null);
    setFormName("");
    setFormUrl("");
  }, []);

  function handleSaveNew() {
    const trimmedName = formName.trim();
    const trimmedUrl = formUrl.trim().replace(/\/$/, "");

    if (!trimmedName) {
      addToast("error", t("connectionsNameRequired"));
      return;
    }
    if (!isValidUrl(trimmedUrl)) {
      addToast("error", t("connectionsInvalidUrl"));
      return;
    }

    const newConn: SavedConnection = {
      id: crypto.randomUUID(),
      name: trimmedName,
      url: trimmedUrl,
    };

    const updated = [...connections, newConn];
    setConnections(updated);
    saveConnections(updated);
    handleCancelForm();
  }

  function handleSaveEdit() {
    if (!editingId) return;

    const trimmedName = formName.trim();
    const trimmedUrl = formUrl.trim().replace(/\/$/, "");

    if (!trimmedName) {
      addToast("error", t("connectionsNameRequired"));
      return;
    }
    if (!isValidUrl(trimmedUrl)) {
      addToast("error", t("connectionsInvalidUrl"));
      return;
    }

    const updated = connections.map((c) =>
      c.id === editingId ? { ...c, name: trimmedName, url: trimmedUrl } : c
    );
    setConnections(updated);
    saveConnections(updated);
    handleCancelForm();
  }

  async function handleDelete(conn: SavedConnection) {
    const ok = await confirm({
      message: t("connectionsDeleteConfirm", { name: conn.name }),
      danger: true,
    });
    if (!ok) return;

    const updated = connections.filter((c) => c.id !== conn.id);
    setConnections(updated);
    saveConnections(updated);

    // If deleted connection was active, revert to default
    if (isActiveUrl(conn.url)) {
      localStorage.removeItem(ACTIVE_URL_KEY);
      window.location.reload();
    }
  }

  async function handleConnect(url: string) {
    if (isActiveUrl(url)) return; // already connected

    const ok = await confirm({
      message: t("connectionsReloadWarning"),
    });
    if (!ok) return;

    // Clear localStorage for default URL so resolveServerUrl() falls back to env
    if (url === defaultUrl) {
      localStorage.removeItem(ACTIVE_URL_KEY);
    } else {
      localStorage.setItem(ACTIVE_URL_KEY, url);
    }

    window.location.reload();
  }

  // ─── Render ───

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("connectionsTitle")}</h2>
      <p className="settings-hint" style={{ marginBottom: 20 }}>
        {t("connectionsDescription")}
      </p>

      {/* ═══ Default Connection ═══ */}
      <div className="conn-item">
        <div className="conn-item-info">
          <div className="conn-item-name">
            {t("connectionsDefault")}
            {isActiveUrl(defaultUrl) && (
              <span className="conn-active-badge">{t("connectionsConnected")}</span>
            )}
          </div>
          <div className="conn-item-url">{defaultUrl}</div>
        </div>
        <div className="conn-item-actions">
          {!isActiveUrl(defaultUrl) && (
            <button
              className="settings-btn settings-btn-secondary"
              onClick={() => handleConnect(defaultUrl)}
            >
              {t("connectionsConnect")}
            </button>
          )}
        </div>
      </div>

      {/* ═══ Saved Connections ═══ */}
      {connections.map((conn) => (
        <div key={conn.id} className="conn-item">
          {editingId === conn.id ? (
            /* Edit mode */
            <div className="conn-form-inline">
              <div className="conn-form-fields">
                <input
                  className="settings-input"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t("connectionsNamePlaceholder")}
                  autoFocus
                />
                <input
                  className="settings-input"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder={t("connectionsUrlPlaceholder")}
                />
              </div>
              <div className="conn-form-buttons">
                <button className="settings-btn" onClick={handleSaveEdit}>
                  {t("connectionsSave")}
                </button>
                <button
                  className="settings-btn settings-btn-secondary"
                  onClick={handleCancelForm}
                >
                  {t("connectionsCancel")}
                </button>
              </div>
            </div>
          ) : (
            /* Display mode */
            <>
              <div className="conn-item-info">
                <div className="conn-item-name">
                  {conn.name}
                  {isActiveUrl(conn.url) && (
                    <span className="conn-active-badge">{t("connectionsConnected")}</span>
                  )}
                </div>
                <div className="conn-item-url">{conn.url}</div>
              </div>
              <div className="conn-item-actions">
                {!isActiveUrl(conn.url) && (
                  <button
                    className="settings-btn settings-btn-secondary"
                    onClick={() => handleConnect(conn.url)}
                  >
                    {t("connectionsConnect")}
                  </button>
                )}
                <button
                  className="settings-btn settings-btn-secondary"
                  onClick={() => handleEdit(conn)}
                >
                  {t("connectionsEdit")}
                </button>
                <button
                  className="settings-btn settings-btn-danger"
                  onClick={() => handleDelete(conn)}
                >
                  {t("connectionsDelete")}
                </button>
              </div>
            </>
          )}
        </div>
      ))}

      {/* ═══ Add Form ═══ */}
      {isAdding ? (
        <div className="conn-item conn-form-inline">
          <div className="conn-form-fields">
            <input
              className="settings-input"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t("connectionsNamePlaceholder")}
              autoFocus
            />
            <input
              className="settings-input"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder={t("connectionsUrlPlaceholder")}
            />
          </div>
          <div className="conn-form-buttons">
            <button className="settings-btn" onClick={handleSaveNew}>
              {t("connectionsSave")}
            </button>
            <button
              className="settings-btn settings-btn-secondary"
              onClick={handleCancelForm}
            >
              {t("connectionsCancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          className="settings-btn"
          style={{ marginTop: 16 }}
          onClick={handleAdd}
        >
          {t("connectionsAddNew")}
        </button>
      )}
    </div>
  );
}

export default ConnectionsSettings;
