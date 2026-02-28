/**
 * ServerGeneralSettings — Sunucu genel ayarları sekmesi.
 *
 * Sunucu adı, ikon, davet ayarı ve LiveKit (ses sunucusu) ayarlarını yönetir.
 * LiveKit bölümü sadece self-hosted sunucularda ve owner için düzenlenebilir.
 *
 * CSS class'ları: .settings-section, .settings-section-title,
 * .settings-field, .settings-label, .settings-input, .settings-btn
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useServerStore } from "../../stores/serverStore";
import { useAuthStore } from "../../stores/authStore";
import * as serverApi from "../../api/servers";
import AvatarUpload from "./AvatarUpload";
import type { Server } from "../../types";

/** LiveKit ayarları — backend'den gelen tip */
type LiveKitSettings = {
  url: string;
  is_platform_managed: boolean;
};

function ServerGeneralSettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const currentUser = useAuthStore((s) => s.user);

  const [server, setServer] = useState<Server | null>(null);
  const [editName, setEditName] = useState("");
  const [editInviteRequired, setEditInviteRequired] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // LiveKit settings state
  const [lkSettings, setLkSettings] = useState<LiveKitSettings | null>(null);
  const [lkNotFound, setLkNotFound] = useState(false);
  const [editLkUrl, setEditLkUrl] = useState("");
  const [editLkKey, setEditLkKey] = useState("");
  const [editLkSecret, setEditLkSecret] = useState("");
  const [isLkSaving, setIsLkSaving] = useState(false);

  const isOwner = server !== null && currentUser !== null && server.owner_id === currentUser.id;

  useEffect(() => {
    // Server değiştiğinde eski state'i temizle — yeni sunucu
    // yüklenene kadar loading göster, stale veri gösterme.
    setServer(null);
    setIsLoaded(false);
    setLkSettings(null);
    setLkNotFound(false);
    setEditLkUrl("");
    setEditLkKey("");
    setEditLkSecret("");

    async function fetchServer() {
      if (!activeServerId) return;
      const res = await serverApi.getServer(activeServerId);
      if (res.success && res.data) {
        setServer(res.data);
        setEditName(res.data.name);
        setEditInviteRequired(res.data.invite_required);

        // LiveKit ayarlarını da getir (livekit_instance_id varsa)
        if (res.data.livekit_instance_id) {
          const lkRes = await serverApi.getLiveKitSettings(activeServerId);
          if (lkRes.success && lkRes.data) {
            setLkSettings(lkRes.data);
            setEditLkUrl(lkRes.data.url);
          } else {
            setLkNotFound(true);
          }
        } else {
          setLkNotFound(true);
        }
      }
      setIsLoaded(true);
    }
    fetchServer();
  }, [activeServerId]);

  const hasChanges =
    server !== null &&
    (editName !== server.name ||
      editInviteRequired !== server.invite_required);

  async function handleSave() {
    if (!hasChanges || isSaving) return;

    setIsSaving(true);
    try {
      if (!activeServerId) return;
      const res = await serverApi.updateServer(activeServerId, {
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

  async function handleLiveKitSave() {
    if (!activeServerId || isLkSaving) return;

    // Tüm alanlar zorunlu
    if (!editLkUrl.trim() || !editLkKey.trim() || !editLkSecret.trim()) {
      addToast("error", t("livekitSaveError"));
      return;
    }

    setIsLkSaving(true);
    try {
      const res = await serverApi.updateServer(activeServerId, {
        livekit_url: editLkUrl.trim(),
        livekit_key: editLkKey.trim(),
        livekit_secret: editLkSecret.trim(),
      });
      if (res.success) {
        addToast("success", t("livekitSaved"));
        // URL güncellendi — lkSettings'i de güncelle
        setLkSettings((prev) =>
          prev ? { ...prev, url: editLkUrl.trim() } : prev
        );
        // Key/Secret input'larını temizle (güvenlik — ekranda kalmasın)
        setEditLkKey("");
        setEditLkSecret("");
      } else {
        addToast("error", res.error ?? t("livekitSaveError"));
      }
    } catch {
      addToast("error", t("livekitSaveError"));
    } finally {
      setIsLkSaving(false);
    }
  }

  async function handleIconUpload(file: File) {
    if (!activeServerId) return;
    try {
      const res = await serverApi.uploadServerIcon(activeServerId, file);
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

  // Self-hosted ve owner → düzenlenebilir LiveKit bölümü
  const isSelfHosted = lkSettings !== null && !lkSettings.is_platform_managed;
  const showLiveKitEdit = isSelfHosted && isOwner;

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
          <p style={{ fontSize: 13, color: "var(--t2)", marginTop: 2 }}>
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

      {/* ─── LiveKit Settings ─── */}
      {server.livekit_instance_id && (
        <>
          <div style={{ height: 1, background: "var(--b1)", margin: "24px 0" }} />
          <h2 className="settings-section-title">{t("livekitSettings")}</h2>
          <p style={{ fontSize: 13, color: "var(--t2)", marginBottom: 16 }}>
            {t("livekitSettingsDesc")}
          </p>

          {/* Platform-managed: sadece bilgi göster */}
          {lkSettings?.is_platform_managed && (
            <p style={{ fontSize: 14, color: "var(--t1)" }}>
              {t("livekitPlatformManaged")}
            </p>
          )}

          {/* LiveKit yok veya yüklenemedi */}
          {lkNotFound && (
            <p style={{ fontSize: 14, color: "var(--t2)" }}>
              {t("livekitNoInstance")}
            </p>
          )}

          {/* Self-hosted: mevcut URL + düzenleme formu (sadece owner) */}
          {isSelfHosted && (
            <>
              {/* Mevcut URL gösterimi */}
              <div className="settings-field">
                <label className="settings-label">{t("livekitCurrentUrl")}</label>
                <p style={{
                  fontSize: 14,
                  color: "var(--t0)",
                  fontFamily: "var(--font-mono)",
                  background: "var(--b0)",
                  padding: "8px 12px",
                  borderRadius: 6,
                  wordBreak: "break-all",
                }}>
                  {lkSettings.url}
                </p>
              </div>

              {showLiveKitEdit && (
                <>
                  {/* LiveKit URL */}
                  <div className="settings-field">
                    <label htmlFor="lkUrl" className="settings-label">
                      {t("livekitUrl")}
                    </label>
                    <input
                      id="lkUrl"
                      type="text"
                      value={editLkUrl}
                      onChange={(e) => setEditLkUrl(e.target.value)}
                      placeholder={t("livekitUrlPlaceholder")}
                      className="settings-input"
                    />
                  </div>

                  {/* LiveKit API Key */}
                  <div className="settings-field">
                    <label htmlFor="lkKey" className="settings-label">
                      {t("livekitApiKey")}
                    </label>
                    <input
                      id="lkKey"
                      type="text"
                      value={editLkKey}
                      onChange={(e) => setEditLkKey(e.target.value)}
                      placeholder={t("livekitApiKeyPlaceholder")}
                      className="settings-input"
                    />
                  </div>

                  {/* LiveKit API Secret */}
                  <div className="settings-field">
                    <label htmlFor="lkSecret" className="settings-label">
                      {t("livekitApiSecret")}
                    </label>
                    <input
                      id="lkSecret"
                      type="password"
                      value={editLkSecret}
                      onChange={(e) => setEditLkSecret(e.target.value)}
                      placeholder={t("livekitApiSecretPlaceholder")}
                      className="settings-input"
                    />
                  </div>

                  {/* LiveKit Save */}
                  <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 8 }}>
                    <button
                      onClick={handleLiveKitSave}
                      disabled={
                        isLkSaving ||
                        !editLkUrl.trim() ||
                        !editLkKey.trim() ||
                        !editLkSecret.trim()
                      }
                      className="settings-btn"
                    >
                      {isLkSaving ? t("saveChanges") + "..." : t("saveChanges")}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default ServerGeneralSettings;
