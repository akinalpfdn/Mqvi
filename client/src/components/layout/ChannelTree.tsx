/**
 * ChannelTree — VS Code tarzı collapsible kanal ağacı.
 *
 * Sıralama:
 * 1. Friends (collapsible) — placeholder, Faz 4'te implement edilecek
 * 2. DMs (collapsible) — aktif DM kanalları
 * 3. Server (collapsible) — kategoriler altında text + voice kanalları
 *    - Her voice kanalı altında bağlı kullanıcılar inline gösterilir
 *
 * Indent seviyeleri:
 * - Section başlığı (Friends/DMs/Server): 0px
 * - Kategori başlığı: 8px
 * - Kanal: 20px
 * - Voice kullanıcısı: 32px
 *
 * Tıklama:
 * - Text kanal: selectChannel() + openTab("text")
 * - Voice kanal: onJoinVoice(channelId) + openTab("voice")
 * - DM: selectDM() + openTab("dm")
 *
 * CSS class'ları: .ch-tree, .ch-tree-section, .ch-tree-section-header,
 * .ch-tree-chevron, .ch-tree-item, .ch-tree-item.active,
 * .ch-tree-icon, .ch-tree-label, .ch-tree-badge,
 * .ch-tree-voice-user, .ch-tree-vu-dot
 */

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useUIStore } from "../../stores/uiStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useDMStore } from "../../stores/dmStore";
import { useFriendStore } from "../../stores/friendStore";
import { useMemberStore } from "../../stores/memberStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as channelApi from "../../api/channels";
import Avatar from "../shared/Avatar";

type ChannelTreeProps = {
  onJoinVoice: (channelId: string) => void;
};

function ChannelTree({ onJoinVoice }: ChannelTreeProps) {
  const { t } = useTranslation("common");
  const { t: tVoice } = useTranslation("voice");

  const toggleSection = useSidebarStore((s) => s.toggleSection);
  /**
   * expandedSections MAP'ine subscribe ol — reactive re-render sağlar.
   *
   * ÖNCEKİ HATA: `isSectionExpanded` fonksiyonuna subscribe edilmişti.
   * Zustand selector'ı fonksiyon referansını döndürüyordu, bu referans
   * hiç değişmediği için toggleSection() çağrıldığında component
   * re-render OLMUYORDU → collapse/expand çalışmıyordu.
   *
   * Çözüm: expandedSections verisine doğrudan subscribe olup,
   * component-local helper ile kontrol etmek.
   */
  const expandedSections = useSidebarStore((s) => s.expandedSections);

  /** Section açık mı? Map'te yoksa varsayılan true (ilk açılışta hep açık) */
  function isSectionExpanded(key: string): boolean {
    return expandedSections[key] ?? true;
  }

  const categories = useChannelStore((s) => s.categories);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const server = useServerStore((s) => s.server);

  const openTab = useUIStore((s) => s.openTab);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const unreadCounts = useReadStateStore((s) => s.unreadCounts);

  const dmChannels = useDMStore((s) => s.channels);
  const selectedDMId = useDMStore((s) => s.selectedDMId);
  const selectDM = useDMStore((s) => s.selectDM);
  const dmUnreadCounts = useDMStore((s) => s.dmUnreadCounts);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const fetchMessages = useDMStore((s) => s.fetchMessages);

  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);

  const currentUser = useAuthStore((s) => s.user);
  const members = useMemberStore((s) => s.members);
  const addToast = useToastStore((s) => s.addToast);
  const { t: tCh } = useTranslation("channels");

  // Permission: MANAGE_CHANNELS yetkisi olan kullanıcılar kanal ekleyebilir
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageChannels = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageChannels)
    : false;

  // ─── Inline Create Channel State ───
  // createTarget: hangi kategoriye kanal ekleniyor (category_id)
  const [createTarget, setCreateTarget] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  /**
   * Kategorideki kanalların türüne bakarak yeni kanal türünü otomatik belirle.
   * Tüm kanallar voice ise → "voice", aksi halde → "text".
   * Bu sayede kullanıcı text category'de + basınca text, voice category'de voice oluşturur.
   */
  function inferChannelType(categoryId: string): "text" | "voice" {
    const cat = categories.find((c) => c.category.id === categoryId);
    if (!cat || cat.channels.length === 0) return "text";
    const allVoice = cat.channels.every((ch) => ch.type === "voice");
    return allVoice ? "voice" : "text";
  }

  const handleCreateChannel = useCallback(async () => {
    const trimmed = createName.trim();
    if (!trimmed || isCreating || !createTarget) return;

    const type = inferChannelType(createTarget);

    setIsCreating(true);
    const res = await channelApi.createChannel({
      name: trimmed,
      type,
      category_id: createTarget,
    });

    if (res.success) {
      addToast("success", tCh("channelCreated"));
      setCreateName("");
      setCreateTarget(null);
    } else {
      addToast("error", tCh("channelCreateError"));
    }
    setIsCreating(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createName, createTarget, isCreating, addToast, tCh, categories]);

  // ─── Handlers ───

  function handleTextChannelClick(channelId: string, channelName: string) {
    selectChannel(channelId);
    openTab(channelId, "text", channelName);
  }

  function handleVoiceChannelClick(channelId: string, channelName: string) {
    onJoinVoice(channelId);
    openTab(channelId, "voice", channelName);
  }

  function handleDMClick(dmId: string, userName: string) {
    selectDM(dmId);
    openTab(dmId, "dm", userName);
    clearDMUnread(dmId);
    fetchMessages(dmId);
  }

  function handleFriendsClick() {
    openTab("friends", "friends", t("friends"));
  }

  // ─── Render helpers ───

  /** Chevron ikonu — section açık/kapalı durumuna göre döner */
  function Chevron({ expanded }: { expanded: boolean }) {
    return (
      <span className={`ch-tree-chevron${expanded ? " expanded" : ""}`}>
        &#x276F;
      </span>
    );
  }

  return (
    <div className="ch-tree">
      {/* ═══ Friends Section ═══ */}
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("friends")}
        >
          <Chevron expanded={isSectionExpanded("friends")} />
          <span>{t("friends")}</span>
          {incoming.length > 0 && (
            <span className="ch-tree-badge">{incoming.length}</span>
          )}
        </button>

        {isSectionExpanded("friends") && (
          <div className="ch-tree-section-body">
            {/* Friends tab açma butonu */}
            <button
              className="ch-tree-item"
              onClick={handleFriendsClick}
            >
              <span className="ch-tree-icon">&#128101;</span>
              <span className="ch-tree-label">{t("friends")}</span>
              {incoming.length > 0 && (
                <span className="ch-tree-badge">{incoming.length}</span>
              )}
            </button>

            {/* Online arkadaşlar listesi */}
            {friends
              .filter((f) => f.user_status === "online" || f.user_status === "idle" || f.user_status === "dnd")
              .slice(0, 10)
              .map((friend) => (
                <button
                  key={friend.user_id}
                  className="ch-tree-item"
                  onClick={() => handleFriendsClick()}
                >
                  <Avatar
                    name={friend.display_name ?? friend.username}
                    avatarUrl={friend.avatar_url ?? undefined}
                    size={24}
                  />
                  <span className="ch-tree-label">
                    {friend.display_name ?? friend.username}
                  </span>
                  <span
                    className="ch-tree-vu-dot"
                    style={{
                      background:
                        friend.user_status === "online"
                          ? "var(--green)"
                          : friend.user_status === "idle"
                            ? "var(--yellow, #f0b232)"
                            : "var(--red)",
                    }}
                  />
                </button>
              ))}
          </div>
        )}
      </div>

      {/* ═══ DMs Section ═══ */}
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("dms")}
        >
          <Chevron expanded={isSectionExpanded("dms")} />
          <span>{t("directMessages")}</span>
        </button>

        {isSectionExpanded("dms") && (
          <div className="ch-tree-section-body">
            {dmChannels.length === 0 ? (
              <div className="ch-tree-placeholder">
                <span className="ch-tree-placeholder-text">—</span>
              </div>
            ) : (
              dmChannels.map((dm) => {
                const isActive = dm.id === selectedDMId;
                const unread = dmUnreadCounts[dm.id] ?? 0;
                const name = dm.other_user.display_name || dm.other_user.username;

                return (
                  <button
                    key={dm.id}
                    className={`ch-tree-item ch-tree-dm${isActive ? " active" : ""}${unread > 0 ? " has-unread" : ""}`}
                    onClick={() => handleDMClick(dm.id, name)}
                  >
                    <Avatar
                      name={name}
                      avatarUrl={dm.other_user.avatar_url}
                      size={24}
                      isCircle
                    />
                    <span className="ch-tree-label">{name}</span>
                    {unread > 0 && (
                      <span className="ch-tree-badge">{unread}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ═══ Server Section — sunucu ikonu + ismi ═══ */}
      <div className="ch-tree-section">
        <button
          className="ch-tree-server-header"
          onClick={() => toggleSection("server")}
        >
          <Chevron expanded={isSectionExpanded("server")} />
          {server?.icon_url ? (
            <img
              src={server.icon_url}
              alt={server.name}
              className="ch-tree-server-icon"
            />
          ) : (
            <span className="ch-tree-server-icon-fallback">
              {(server?.name ?? "S").charAt(0).toUpperCase()}
            </span>
          )}
          <span className="ch-tree-server-name">{server?.name ?? t("server")}</span>
          {/* Server-level unread badge — tüm kanalların toplam okunmamış sayısı */}
          {(() => {
            const total = Object.values(unreadCounts).reduce((sum, c) => sum + c, 0);
            return total > 0 ? (
              <span className="ch-tree-server-badge">{total > 99 ? "99+" : total}</span>
            ) : null;
          })()}
        </button>

        {isSectionExpanded("server") && (
          <div className="ch-tree-section-body">
            {categories.map((cg) => {
              const catKey = `cat:${cg.category.id}`;
              const catExpanded = isSectionExpanded(catKey);

              return (
                <div key={cg.category.id} className="ch-tree-category">
                  {/* Kategori başlığı + kanal ekleme butonu */}
                  <div className="ch-tree-cat-row">
                    <button
                      className="ch-tree-cat-header"
                      onClick={() => toggleSection(catKey)}
                    >
                      <Chevron expanded={catExpanded} />
                      <span>{cg.category.name}</span>
                    </button>
                    {canManageChannels && (
                      <button
                        className="ch-tree-cat-add"
                        title={tCh("createChannel")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCreateTarget(
                            createTarget === cg.category.id ? null : cg.category.id
                          );
                          setCreateName("");
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>

                  {/* Inline kanal oluşturma formu */}
                  {createTarget === cg.category.id && (
                    <div className="ch-tree-create-form">
                      <input
                        className="ch-tree-create-input"
                        type="text"
                        placeholder={tCh("channelName")}
                        value={createName}
                        onChange={(e) => setCreateName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleCreateChannel();
                          if (e.key === "Escape") setCreateTarget(null);
                        }}
                        autoFocus
                      />
                      <div className="ch-tree-create-actions">
                        <button
                          className="ch-tree-create-btn"
                          onClick={handleCreateChannel}
                          disabled={!createName.trim() || isCreating}
                        >
                          {isCreating ? "..." : tCh("createChannel")}
                        </button>
                        <button
                          className="ch-tree-create-cancel"
                          onClick={() => setCreateTarget(null)}
                        >
                          {tCh("cancel")}
                        </button>
                      </div>
                    </div>
                  )}

                  {catExpanded && cg.channels.map((ch) => {
                    const isText = ch.type === "text";
                    const isActive = isText
                      ? ch.id === selectedChannelId
                      : ch.id === currentVoiceChannelId;
                    const unread = unreadCounts[ch.id] ?? 0;
                    const participants = voiceStates[ch.id] ?? [];

                    return (
                      <div key={ch.id}>
                        {/* Kanal satırı */}
                        <button
                          className={`ch-tree-item${isActive ? " active" : ""}${!isText ? " voice" : ""}${unread > 0 ? " has-unread" : ""}`}
                          onClick={() =>
                            isText
                              ? handleTextChannelClick(ch.id, ch.name)
                              : handleVoiceChannelClick(ch.id, ch.name)
                          }
                          title={
                            isText
                              ? `#${ch.name}`
                              : `${ch.name} — ${tVoice("joinVoice")}`
                          }
                        >
                          <span className="ch-tree-icon">
                            {isText ? "#" : "\uD83D\uDD0A"}
                          </span>
                          <span className="ch-tree-label">{ch.name}</span>
                          {unread > 0 && (
                            <span className="ch-tree-unread-dot" title={`${unread}`} />
                          )}
                        </button>

                        {/* Voice kanalı altında bağlı kullanıcılar */}
                        {!isText && participants.length > 0 && (
                          <div className="ch-tree-voice-users">
                            {participants.map((p) => (
                              <div key={p.user_id} className="ch-tree-voice-user">
                                <Avatar
                                  name={p.username}
                                  avatarUrl={p.avatar_url}
                                  size={22}
                                  isCircle
                                />
                                <span className="ch-tree-vu-name">{p.username}</span>
                                {/* Durum ikonları: yayın, mute, deafen */}
                                <span className="ch-tree-vu-icons">
                                  {p.is_streaming && (
                                    <svg className="ch-tree-vu-icon ch-tree-vu-stream" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} title={tVoice("screenShare")}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                    </svg>
                                  )}
                                  {p.is_deafened ? (
                                    <svg className="ch-tree-vu-icon ch-tree-vu-deafen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636" />
                                    </svg>
                                  ) : p.is_muted ? (
                                    <svg className="ch-tree-vu-icon ch-tree-vu-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                                    </svg>
                                  ) : (
                                    <span className="ch-tree-vu-dot" />
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default ChannelTree;
