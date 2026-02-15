/**
 * ChannelSettings — Kanal yönetimi Settings paneli.
 *
 * Basit bir liste + create form yapısı:
 * - Mevcut kanalları listeler (text/voice ikonu ile)
 * - "Create Channel" butonu ve inline form ile yeni kanal oluşturma
 * - Her kanalın yanında silme butonu
 *
 * ManageChannels yetkisi gerektirir (SettingsNav zaten permission-gated).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import { useToastStore } from "../../stores/toastStore";
import * as channelApi from "../../api/channels";

function ChannelSettings() {
  const { t } = useTranslation("channels");
  const categories = useChannelStore((s) => s.categories);
  const addToast = useToastStore((s) => s.addToast);

  // Tüm kanalları flat olarak al
  const allChannels = categories
    .flatMap((cg) => cg.channels)
    .sort((a, b) => a.position - b.position);

  // ─── Create Form State ───
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"text" | "voice">("text");
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed || isCreating) return;

    setIsCreating(true);
    const res = await channelApi.createChannel({
      name: trimmed,
      type: newType,
    });

    if (res.success) {
      addToast({ type: "success", message: t("channelCreated") });
      setNewName("");
      setShowCreate(false);
    } else {
      addToast({ type: "error", message: t("channelCreateError") });
    }
    setIsCreating(false);
  }

  async function handleDelete(channelId: string, channelName: string) {
    if (!window.confirm(t("deleteConfirm", { name: channelName }))) return;

    const res = await channelApi.deleteChannel(channelId);
    if (res.success) {
      addToast({ type: "success", message: t("channelDeleted") });
    } else {
      addToast({ type: "error", message: t("channelDeleteError") });
    }
  }

  return (
    <div>
      <h2 className="settings-section-title">{t("channelsTitle")}</h2>

      {/* Kanal listesi */}
      <div className="channel-settings-list">
        {allChannels.length === 0 && (
          <p style={{ color: "var(--t3)", fontSize: 13 }}>{t("noChannels")}</p>
        )}

        {allChannels.map((ch) => (
          <div key={ch.id} className="channel-settings-item">
            <span className="channel-settings-icon">
              {ch.type === "voice" ? "\uD83D\uDD0A" : "#"}
            </span>
            <span className="channel-settings-name">{ch.name}</span>
            <span className="channel-settings-type">
              {ch.type === "voice" ? t("voice") : t("text")}
            </span>
            <button
              className="channel-settings-delete"
              onClick={() => handleDelete(ch.id, ch.name)}
              title={t("deleteChannel")}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Create form */}
      {showCreate ? (
        <div className="channel-settings-create-form">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="settings-input"
              placeholder={t("channelName")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setShowCreate(false);
              }}
              autoFocus
              style={{ flex: 1 }}
            />
            <select
              className="settings-input"
              value={newType}
              onChange={(e) => setNewType(e.target.value as "text" | "voice")}
              style={{ width: 100 }}
            >
              <option value="text">{t("text")}</option>
              <option value="voice">{t("voice")}</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="settings-btn"
              onClick={handleCreate}
              disabled={!newName.trim() || isCreating}
            >
              {isCreating ? "..." : t("createChannel")}
            </button>
            <button
              className="settings-btn settings-btn-secondary"
              onClick={() => setShowCreate(false)}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          className="settings-btn"
          onClick={() => setShowCreate(true)}
          style={{ marginTop: 12 }}
        >
          + {t("createChannel")}
        </button>
      )}
    </div>
  );
}

export default ChannelSettings;
