/**
 * ChannelSettings — Kanal yönetimi Settings paneli.
 *
 * RoleSettings ile aynı layout pattern'ını kullanır:
 * - Sol panel: Kanal listesi (role-list pattern)
 * - Sağ panel: Seçili kanal için başlık + ChannelPermissionEditor
 *
 * "+" butonu ile inline create form, "✕" ile kanal silme.
 * ManageChannels yetkisi gerektirir (SettingsNav zaten permission-gated).
 *
 * CSS class'ları: .channel-settings-*, .role-list, .role-list-item
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import * as channelApi from "../../api/channels";
import { useServerStore } from "../../stores/serverStore";
import ChannelPermissionEditor from "./ChannelPermissionEditor";
import type { Channel } from "../../types";

function ChannelSettings() {
  const { t } = useTranslation("channels");
  const { t: tSettings } = useTranslation("settings");
  const categories = useChannelStore((s) => s.categories);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  // Tüm kanalları flat olarak al
  const allChannels = categories
    .flatMap((cg) => cg.channels)
    .sort((a, b) => a.position - b.position);

  // Seçili kanal
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);

  // ─── Create Form State ───
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"text" | "voice">("text");
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed || isCreating) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    setIsCreating(true);
    const res = await channelApi.createChannel(serverId, {
      name: trimmed,
      type: newType,
    });

    if (res.success) {
      addToast("success", t("channelCreated"));
      setNewName("");
      setShowCreate(false);
    } else {
      addToast("error", t("channelCreateError"));
    }
    setIsCreating(false);
  }

  async function handleDelete(channelId: string, channelName: string) {
    const ok = await confirm({
      message: t("deleteConfirm", { name: channelName }),
      confirmLabel: t("deleteChannel"),
      danger: true,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await channelApi.deleteChannel(serverId, channelId);
    if (res.success) {
      addToast("success", t("channelDeleted"));
      if (selectedChannel?.id === channelId) setSelectedChannel(null);
    } else {
      addToast("error", t("channelDeleteError"));
    }
  }

  return (
    <div className="channel-settings-wrapper">
      {/* Sol Panel: Kanal Listesi — RoleSettings sol panel ile aynı pattern */}
      <div className="role-list">
        {/* Header */}
        <div className="channel-settings-header">
          <span className="channel-settings-header-label">
            {tSettings("channels")}
          </span>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="settings-btn channel-settings-header-btn"
          >
            +
          </button>
        </div>

        {/* Create Form */}
        {showCreate && (
          <div className="channel-settings-create-inline">
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
            />
            <select
              className="settings-input"
              value={newType}
              onChange={(e) => setNewType(e.target.value as "text" | "voice")}
            >
              <option value="text">{t("text")}</option>
              <option value="voice">{t("voice")}</option>
            </select>
            <button
              className="settings-btn"
              onClick={handleCreate}
              disabled={!newName.trim() || isCreating}
            >
              {isCreating ? "..." : t("createChannel")}
            </button>
          </div>
        )}

        {/* Kanal listesi */}
        <div className="channel-settings-ch-list">
          {allChannels.map((ch) => (
            <div
              key={ch.id}
              className={`role-list-item channel-settings-ch-row${ch.id === selectedChannel?.id ? " active" : ""}`}
              onClick={() => setSelectedChannel(ch)}
            >
              <span className="channel-settings-ch-icon">
                {ch.type === "voice" ? "\uD83D\uDD0A" : "#"}
              </span>
              <span className="role-list-name">{ch.name}</span>
              <button
                className="channel-settings-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(ch.id, ch.name);
                }}
                title={t("deleteChannel")}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Sağ Panel: settings-content — RoleSettings sağ panel ile aynı pattern */}
      <div className="settings-content channel-settings-right">
        {selectedChannel ? (
          <div className="channel-perm-section">
            <h2 className="settings-section-title channel-settings-right-title">
              {selectedChannel.type === "voice" ? "\uD83D\uDD0A" : "#"} {selectedChannel.name}
            </h2>
            <ChannelPermissionEditor channel={selectedChannel} />
          </div>
        ) : (
          <div className="no-channel">
            {tSettings("selectChannelToEdit")}
          </div>
        )}
      </div>
    </div>
  );
}

export default ChannelSettings;
