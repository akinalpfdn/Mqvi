/** ServerGeneralSettings — Server name, icon, invite settings, and LiveKit config (self-hosted, owner-only). */

import { useState, useEffect, useCallback } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useServerStore } from "../../stores/serverStore";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers } from "../../stores/memberStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as serverApi from "../../api/servers";
import AvatarUpload from "./AvatarUpload";
import type { Server } from "../../types";

/** LiveKit settings from backend */
type LiveKitSettings = {
  url: string;
  is_platform_managed: boolean;
};

function ServerGeneralSettings() {
  const { t } = useTranslation("settings");
  const { t: tServers } = useTranslation("servers");
  const addToast = useToastStore((s) => s.addToast);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const deleteServerAction = useServerStore((s) => s.deleteServer);
  const currentUser = useAuthStore((s) => s.user);

  const [server, setServer] = useState<Server | null>(null);
  const [editName, setEditName] = useState("");
  const [editInviteRequired, setEditInviteRequired] = useState(false);
  const [editAFKTimeout, setEditAFKTimeout] = useState(60);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // LiveKit settings state
  const [lkSettings, setLkSettings] = useState<LiveKitSettings | null>(null);
  const [lkNotFound, setLkNotFound] = useState(false);
  const [editLkUrl, setEditLkUrl] = useState("");
  const [editLkKey, setEditLkKey] = useState("");
  const [editLkSecret, setEditLkSecret] = useState("");
  const [isLkSaving, setIsLkSaving] = useState(false);

  // Delete server state
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  const isOwner = server !== null && currentUser !== null && server.owner_id === currentUser.id;

  // Admin permission check
  const members = useActiveMembers();
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const isAdmin = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.Admin)
    : false;

  useEffect(() => {
    // Clear stale state on server switch
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
        setEditAFKTimeout(res.data.afk_timeout_minutes ?? 60);

        // Fetch LiveKit settings if instance exists
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
      editInviteRequired !== server.invite_required ||
      editAFKTimeout !== (server.afk_timeout_minutes ?? 60));

  async function handleSave() {
    if (!hasChanges || isSaving) return;

    setIsSaving(true);
    try {
      if (!activeServerId) return;
      const res = await serverApi.updateServer(activeServerId, {
        name: editName,
        invite_required: editInviteRequired,
        afk_timeout_minutes: editAFKTimeout,
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

    // All fields required
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
        // Update local lkSettings with new URL
        setLkSettings((prev) =>
          prev ? { ...prev, url: editLkUrl.trim() } : prev
        );
        // Clear key/secret inputs for security
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

  const handleDeleteServer = useCallback(async () => {
    if (!activeServerId || !server || isDeleting) return;
    if (deleteConfirmName !== server.name) return;

    setIsDeleting(true);
    try {
      const ok = await deleteServerAction(activeServerId);
      if (ok) {
        addToast("success", tServers("serverDeleted"));
      } else {
        addToast("error", tServers("confirmDelete", { name: server.name }));
      }
    } catch {
      addToast("error", tServers("confirmDelete", { name: server.name }));
    } finally {
      setIsDeleting(false);
    }
  }, [activeServerId, server, deleteConfirmName, isDeleting, deleteServerAction, addToast, tServers]);

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

  if (!isAdmin) {
    return (
      <div className="no-channel">
        {t("noPermission")}
      </div>
    );
  }

  // Self-hosted + owner = editable LiveKit section
  const isSelfHosted = lkSettings !== null && !lkSettings.is_platform_managed;
  const showLiveKitEdit = isSelfHosted && isOwner;

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("general")}</h2>

      {/* Server Icon */}
      <AvatarUpload
        currentUrl={server.icon_url}
        fallbackText={server.name}
        onUpload={handleIconUpload}
        isCircle={false}
      />

      {/* Server Name */}
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

      {/* AFK Voice Timeout */}
      <div className="settings-field">
        <label htmlFor="afkTimeout" className="settings-label">
          {t("afkTimeout")}
        </label>
        <p style={{ fontSize: 13, color: "var(--t2)", marginTop: 2, marginBottom: 8 }}>{t("afkTimeoutDesc")}</p>
        <select
          id="afkTimeout"
          value={editAFKTimeout}
          onChange={(e) => setEditAFKTimeout(Number(e.target.value))}
          className="settings-input"
          style={{ width: 200 }}
        >
          <option value={15}>{t("afkTimeout15")}</option>
          <option value={30}>{t("afkTimeout30")}</option>
          <option value={45}>{t("afkTimeout45")}</option>
          <option value={60}>{t("afkTimeout60")}</option>
        </select>
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

          {/* Platform-managed: info only */}
          {lkSettings?.is_platform_managed && (
            <p style={{ fontSize: 14, color: "var(--t1)" }}>
              {t("livekitPlatformManaged")}
            </p>
          )}

          {/* LiveKit not found */}
          {lkNotFound && (
            <p style={{ fontSize: 14, color: "var(--t2)" }}>
              {t("livekitNoInstance")}
            </p>
          )}

          {/* Self-hosted: current URL + edit form (owner only) */}
          {isSelfHosted && (
            <>
              {/* Current URL display */}
              <div className="settings-field">
                <label className="settings-label">{t("livekitCurrentUrl")}</label>
                <p className="mono" style={{
                  fontSize: 14,
                  color: "var(--t0)",
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

      {/* ─── Danger Zone — Delete Server ─── */}
      {isOwner && (
        <>
          <div className="dz-separator" />
          <div className="dz-section">
            <h2 className="dz-title">{t("dangerZone")}</h2>

            <div className="dz-card">
              <h3 className="dz-card-title">{tServers("deleteServer")}</h3>
              <p className="dz-card-desc">{tServers("deleteServerWarning")}</p>

              <label className="dz-confirm-label">
                <Trans
                  i18nKey="deleteServerConfirmLabel"
                  ns="servers"
                  values={{ name: server.name }}
                  components={{ strong: <strong /> }}
                />
              </label>
              <input
                type="text"
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                placeholder={tServers("deleteServerConfirmPlaceholder")}
                className="settings-input dz-input"
                autoComplete="off"
                spellCheck={false}
              />

              <button
                onClick={handleDeleteServer}
                disabled={deleteConfirmName !== server.name || isDeleting}
                className="dz-btn"
              >
                {isDeleting ? tServers("deleting") : tServers("deleteServer")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default ServerGeneralSettings;
