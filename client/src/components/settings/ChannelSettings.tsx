/** ChannelSettings — Channel and category management (two-tab panel). */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import * as channelApi from "../../api/channels";
import { useServerStore } from "../../stores/serverStore";
import ChannelPermissionEditor from "./ChannelPermissionEditor";
import CreateChannelModal from "../channels/CreateChannelModal";
import EmojiPicker from "../shared/EmojiPicker";
import type { Channel, Category } from "../../types";

type SettingsTab = "channels" | "categories";

function ChannelSettings() {
  const { t } = useTranslation("channels");
  const { t: tSettings } = useTranslation("settings");
  const categories = useChannelStore((s) => s.categories);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  // ─── Tab State ───
  const [activeTab, setActiveTab] = useState<SettingsTab>("channels");

  // Flatten all channels
  const allChannels = categories
    .flatMap((cg) => cg.channels)
    .sort((a, b) => a.position - b.position);

  // Real categories (excluding uncategorized)
  const realCategories = categories
    .filter((cg) => cg.category.id !== "")
    .map((cg) => cg.category);

  // ─── Channels Tab State ───
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);

  // Sync selectedChannel with store after rename
  useEffect(() => {
    if (!selectedChannel) return;
    const updated = allChannels.find((ch) => ch.id === selectedChannel.id);
    if (updated && (updated.name !== selectedChannel.name || updated.category_id !== selectedChannel.category_id)) {
      setSelectedChannel(updated);
    }
  }, [allChannels, selectedChannel]);

  // ─── Create Modal State ───
  const [showCreateModal, setShowCreateModal] = useState(false);

  // ─── Channel Rename State ───
  const [editName, setEditName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);

  // ─── Channel Category State ───
  const [editCategoryId, setEditCategoryId] = useState("");
  const [isSavingCategory, setIsSavingCategory] = useState(false);

  // Update edit state when selected channel changes
  useEffect(() => {
    if (selectedChannel) {
      setEditName(selectedChannel.name);
      setEditCategoryId(selectedChannel.category_id ?? "");
    }
  }, [selectedChannel]);

  // ─── Emoji picker state ───
  const [showChEmojiPicker, setShowChEmojiPicker] = useState(false);
  const [showCatEmojiPicker, setShowCatEmojiPicker] = useState(false);

  // ─── Categories Tab State ───
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [editCatName, setEditCatName] = useState("");
  const [isSavingCatName, setIsSavingCatName] = useState(false);

  // Sync selectedCategory with store
  useEffect(() => {
    if (!selectedCategory) return;
    const updated = realCategories.find((c) => c.id === selectedCategory.id);
    if (updated && updated.name !== selectedCategory.name) {
      setSelectedCategory(updated);
      setEditCatName(updated.name);
    }
  }, [realCategories, selectedCategory]);

  useEffect(() => {
    if (selectedCategory) {
      setEditCatName(selectedCategory.name);
    }
  }, [selectedCategory]);

  // ─── Channel Handlers ───

  async function handleDeleteChannel(channelId: string, channelName: string) {
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

  async function handleRenameChannel() {
    if (!selectedChannel) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed === selectedChannel.name) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    setIsSavingName(true);
    const res = await channelApi.updateChannel(serverId, selectedChannel.id, {
      name: trimmed,
    });

    if (res.success) {
      addToast("success", t("channelUpdated"));
    } else {
      addToast("error", t("channelUpdateError"));
      setEditName(selectedChannel.name);
    }
    setIsSavingName(false);
  }

  async function handleChangeCategory(newCategoryId: string) {
    if (!selectedChannel) return;
    const currentCatId = selectedChannel.category_id ?? "";
    if (newCategoryId === currentCatId) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    setEditCategoryId(newCategoryId);
    setIsSavingCategory(true);
    const res = await channelApi.updateChannel(serverId, selectedChannel.id, {
      category_id: newCategoryId,
    });

    if (res.success) {
      addToast("success", t("channelUpdated"));
    } else {
      addToast("error", t("channelUpdateError"));
      setEditCategoryId(currentCatId);
    }
    setIsSavingCategory(false);
  }

  const channelNameChanged = selectedChannel
    ? editName.trim() !== selectedChannel.name
    : false;

  // ─── Category Handlers ───

  async function handleDeleteCategory(catId: string, catName: string) {
    const ok = await confirm({
      message: t("deleteCategoryConfirm", { name: catName }),
      confirmLabel: t("deleteCategory"),
      danger: true,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await channelApi.deleteCategory(serverId, catId);
    if (res.success) {
      addToast("success", t("categoryDeleted"));
      if (selectedCategory?.id === catId) setSelectedCategory(null);
    } else {
      addToast("error", t("categoryDeleteError"));
    }
  }

  async function handleRenameCategory() {
    if (!selectedCategory) return;
    const trimmed = editCatName.trim();
    if (!trimmed || trimmed === selectedCategory.name) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    setIsSavingCatName(true);
    const res = await channelApi.updateCategory(serverId, selectedCategory.id, {
      name: trimmed,
    });

    if (res.success) {
      addToast("success", t("categoryUpdated"));
    } else {
      addToast("error", t("categoryUpdateError"));
      setEditCatName(selectedCategory.name);
    }
    setIsSavingCatName(false);
  }

  const catNameChanged = selectedCategory
    ? editCatName.trim() !== selectedCategory.name
    : false;

  return (
    <div className="channel-settings-wrapper">
      {/* Left Panel */}
      <div className="role-list">
        {/* Tab toggle */}
        <div className="channel-settings-tabs">
          <button
            className={`channel-settings-tab${activeTab === "channels" ? " active" : ""}`}
            onClick={() => setActiveTab("channels")}
          >
            {t("tabChannels")}
          </button>
          <button
            className={`channel-settings-tab${activeTab === "categories" ? " active" : ""}`}
            onClick={() => setActiveTab("categories")}
          >
            {t("tabCategories")}
          </button>
        </div>

        {/* Header with + button */}
        <div className="channel-settings-header">
          <span className="channel-settings-header-label">
            {activeTab === "channels" ? t("channelsTitle") : t("categoriesTitle")}
          </span>
          <button
            onClick={() => setShowCreateModal(true)}
            className="settings-btn channel-settings-header-btn"
          >
            +
          </button>
        </div>

        {/* ═══ Channels Tab — left panel ═══ */}
        {activeTab === "channels" && (
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
                    handleDeleteChannel(ch.id, ch.name);
                  }}
                  title={t("deleteChannel")}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ═══ Categories Tab — left panel ═══ */}
        {activeTab === "categories" && (
          <div className="channel-settings-ch-list">
            {realCategories.length === 0 ? (
              <div className="no-channel" style={{ padding: "16px 8px" }}>
                {t("noCategoriesYet")}
              </div>
            ) : (
              realCategories.map((cat) => (
                <div
                  key={cat.id}
                  className={`role-list-item channel-settings-ch-row${cat.id === selectedCategory?.id ? " active" : ""}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  <span className="channel-settings-ch-icon">&#x25BC;</span>
                  <span className="role-list-name">{cat.name}</span>
                  <button
                    className="channel-settings-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteCategory(cat.id, cat.name);
                    }}
                    title={t("deleteCategory")}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Right Panel */}
      <div className="settings-content channel-settings-right">
        {/* ═══ Channels Tab — right panel ═══ */}
        {activeTab === "channels" && (
          selectedChannel ? (
            <div className="channel-perm-section">
              <h2 className="settings-section-title channel-settings-right-title">
                {selectedChannel.type === "voice" ? "\uD83D\uDD0A" : "#"} {selectedChannel.name}
              </h2>

              {/* Channel name edit */}
              <div className="channel-settings-rename-row">
                <label className="settings-label">{t("channelName")}</label>
                <div className="channel-settings-rename-input-row">
                  <div className="name-input-with-emoji">
                    <input
                      className="settings-input"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && channelNameChanged) handleRenameChannel();
                        if (e.key === "Escape") setEditName(selectedChannel.name);
                      }}
                      maxLength={50}
                    />
                    <button
                      type="button"
                      className="name-emoji-btn"
                      onClick={() => setShowChEmojiPicker((p) => !p)}
                      title={t("emoji", { ns: "chat" })}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                        <line x1="9" y1="9" x2="9.01" y2="9" />
                        <line x1="15" y1="9" x2="15.01" y2="9" />
                      </svg>
                    </button>
                    {showChEmojiPicker && (
                      <div className="name-emoji-picker-wrap">
                        <EmojiPicker
                          onSelect={(emoji) => {
                            setEditName((prev) => {
                              const next = prev + emoji;
                              return [...next].length <= 50 ? next : prev;
                            });
                            setShowChEmojiPicker(false);
                          }}
                          onClose={() => setShowChEmojiPicker(false)}
                        />
                      </div>
                    )}
                  </div>
                  {channelNameChanged && (
                    <button
                      className="settings-btn"
                      onClick={handleRenameChannel}
                      disabled={isSavingName}
                    >
                      {isSavingName ? "..." : tSettings("save")}
                    </button>
                  )}
                </div>
              </div>

              {/* Channel category select */}
              <div className="channel-settings-cat-row">
                <label className="settings-label">{t("moveToCategory")}</label>
                <select
                  className="channel-settings-cat-select"
                  value={editCategoryId}
                  onChange={(e) => handleChangeCategory(e.target.value)}
                  disabled={isSavingCategory}
                >
                  <option value="">{t("channelNoCategory")}</option>
                  {realCategories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Channel permissions */}
              <ChannelPermissionEditor channel={selectedChannel} />
            </div>
          ) : (
            <div className="no-channel">
              {tSettings("selectChannelToEdit")}
            </div>
          )
        )}

        {/* ═══ Categories Tab — right panel ═══ */}
        {activeTab === "categories" && (
          selectedCategory ? (
            <div className="channel-perm-section">
              <h2 className="settings-section-title channel-settings-right-title">
                {selectedCategory.name}
              </h2>

              {/* Category name edit */}
              <div className="channel-settings-rename-row">
                <label className="settings-label">{t("categoryName")}</label>
                <div className="channel-settings-rename-input-row">
                  <div className="name-input-with-emoji">
                    <input
                      className="settings-input"
                      value={editCatName}
                      onChange={(e) => setEditCatName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && catNameChanged) handleRenameCategory();
                        if (e.key === "Escape") setEditCatName(selectedCategory.name);
                      }}
                      maxLength={50}
                    />
                    <button
                      type="button"
                      className="name-emoji-btn"
                      onClick={() => setShowCatEmojiPicker((p) => !p)}
                      title={t("emoji", { ns: "chat" })}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                        <line x1="9" y1="9" x2="9.01" y2="9" />
                        <line x1="15" y1="9" x2="15.01" y2="9" />
                      </svg>
                    </button>
                    {showCatEmojiPicker && (
                      <div className="name-emoji-picker-wrap">
                        <EmojiPicker
                          onSelect={(emoji) => {
                            setEditCatName((prev) => {
                              const next = prev + emoji;
                              return [...next].length <= 50 ? next : prev;
                            });
                            setShowCatEmojiPicker(false);
                          }}
                          onClose={() => setShowCatEmojiPicker(false)}
                        />
                      </div>
                    )}
                  </div>
                  {catNameChanged && (
                    <button
                      className="settings-btn"
                      onClick={handleRenameCategory}
                      disabled={isSavingCatName}
                    >
                      {isSavingCatName ? "..." : tSettings("save")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="no-channel">
              {t("selectCategoryToEdit")}
            </div>
          )
        )}
      </div>

      {/* Create Channel/Category Modal */}
      {showCreateModal && (
        <CreateChannelModal onClose={() => setShowCreateModal(false)} />
      )}
    </div>
  );
}

export default ChannelSettings;
