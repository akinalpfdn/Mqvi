/**
 * ServerGeneralSettings — Sunucu genel ayarları sekmesi.
 *
 * CSS class'ları: .settings-section, .settings-section-title,
 * .settings-field, .settings-label, .settings-input, .settings-btn
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import * as serverApi from "../../api/server";
import AvatarUpload from "./AvatarUpload";
import type { Server } from "../../types";

function ServerGeneralSettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  const [server, setServer] = useState<Server | null>(null);
  const [editName, setEditName] = useState("");
  const [editInviteRequired, setEditInviteRequired] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    async function fetchServer() {
      const res = await serverApi.getServer();
      if (res.success && res.data) {
        setServer(res.data);
        setEditName(res.data.name);
        setEditInviteRequired(res.data.invite_required);
      }
      setIsLoaded(true);
    }
    fetchServer();
  }, []);

  const hasChanges =
    server !== null &&
    (editName !== server.name ||
      editInviteRequired !== server.invite_required);

  async function handleSave() {
    if (!hasChanges || isSaving) return;

    setIsSaving(true);
    try {
      const res = await serverApi.updateServer({
        name: editName,
        invite_required: editInviteRequired,
      });
      if (res.success && res.data) {
        setServer(res.data);
        setEditInviteRequired(res.data.invite_required);
        addToast("success", t("serverSaved"));
      } else {
        addToast("error", res.error ?? t("serverSaveError"));
      }
    } catch {
      addToast("error", t("serverSaveError"));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleIconUpload(file: File) {
    try {
      const res = await serverApi.uploadServerIcon(file);
      if (res.success && res.data) {
        setServer(res.data);
        addToast("success", t("serverSaved"));
      } else {
        addToast("error", res.error ?? t("serverSaveError"));
      }
    } catch {
      addToast("error", t("serverSaveError"));
    }
  }

  if (!isLoaded) {
    return (
      <div className="no-channel">
        {t("loading", { ns: "common" })}
      </div>
    );
  }

  if (!server) {
    return (
      <div className="no-channel">
        {t("serverSaveError")}
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("general")}</h2>

      {/* Sunucu İkonu */}
      <AvatarUpload
        currentUrl={server.icon_url}
        fallbackText={server.name}
        onUpload={handleIconUpload}
        isCircle={false}
      />

      {/* Sunucu Adı */}
      <div className="settings-field">
        <label htmlFor="serverName" className="settings-label">
          {t("serverName")}
        </label>
        <input
          id="serverName"
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          maxLength={100}
          className="settings-input"
        />
      </div>

      {/* Invite Required Toggle */}
      <div className="settings-field" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <input
          id="inviteRequired"
          type="checkbox"
          checked={editInviteRequired}
          onChange={(e) => setEditInviteRequired(e.target.checked)}
          style={{ width: 16, height: 16, accentColor: "var(--primary)", cursor: "pointer" }}
        />
        <div>
          <label
            htmlFor="inviteRequired"
            style={{ fontSize: 13, fontWeight: 600, color: "var(--t0)", cursor: "pointer" }}
          >
            {t("inviteRequired")}
          </label>
          <p style={{ fontSize: 11, color: "var(--t2)", marginTop: 2 }}>
            {t("inviteRequiredDesc")}
          </p>
        </div>
      </div>

      {/* Separator */}
      <div style={{ height: 1, background: "var(--b1)", margin: "24px 0" }} />

      {/* Save */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="settings-btn"
        >
          {isSaving ? t("saveChanges") + "..." : t("saveChanges")}
        </button>
        {hasChanges && (
          <span style={{ fontSize: 13, color: "var(--primary)" }}>{t("unsavedChanges")}</span>
        )}
      </div>
    </div>
  );
}

export default ServerGeneralSettings;
