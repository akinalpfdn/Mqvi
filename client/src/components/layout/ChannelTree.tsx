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

import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useUIStore, type TabServerInfo } from "../../stores/uiStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useDMStore } from "../../stores/dmStore";
import { useFriendStore } from "../../stores/friendStore";
import { useMemberStore } from "../../stores/memberStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { resolveAssetUrl } from "../../utils/constants";
import * as channelApi from "../../api/channels";
import Avatar from "../shared/Avatar";
import VoiceUserContextMenu from "../voice/VoiceUserContextMenu";
import AddServerModal from "../servers/AddServerModal";

type ChannelTreeProps = {
  onJoinVoice: (channelId: string) => void;
};

function ChannelTree({ onJoinVoice }: ChannelTreeProps) {
  const { t } = useTranslation("common");
  const { t: tVoice } = useTranslation("voice");
  const { t: tServers } = useTranslation("servers");

  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandSection = useSidebarStore((s) => s.expandSection);
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
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const reorderServers = useServerStore((s) => s.reorderServers);

  // Add Server modal state
  const [showAddServer, setShowAddServer] = useState(false);

  const openTab = useUIStore((s) => s.openTab);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const localMutedUsers = useVoiceStore((s) => s.localMutedUsers);
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const toggleWatchScreenShare = useVoiceStore((s) => s.toggleWatchScreenShare);
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

  // Permission: MOVE_MEMBERS yetkisi olan kullanıcılar başka kullanıcıları
  // voice kanallar arası sürükleyerek taşıyabilir (drag & drop).
  const canMoveMembers = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.MoveMembers)
    : false;

  // Voice user drag & drop için WS send
  const wsSend = useVoiceStore((s) => s._wsSend);

  // ─── Voice User Context Menu State ───
  const [voiceCtxMenu, setVoiceCtxMenu] = useState<{
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    x: number;
    y: number;
  } | null>(null);

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

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    setIsCreating(true);
    const res = await channelApi.createChannel(serverId, {
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

  // ─── Drag & Drop State ───
  // Aynı kategori içinde kanal sıralamasını sürükleyerek değiştirme.
  // HTML5 Drag and Drop API kullanılıyor — harici kütüphane gerektirmez.

  const reorderChannels = useChannelStore((s) => s.reorderChannels);

  /** Sürüklenen kanalın id'si */
  const dragChannelIdRef = useRef<string | null>(null);
  /** Sürüklenen kanalın ait olduğu kategori id'si */
  const dragCategoryIdRef = useRef<string | null>(null);
  /** Drop hedefinin üstünde/altında çizgi göstermek için */
  const [dropIndicator, setDropIndicator] = useState<{
    channelId: string;
    position: "above" | "below";
  } | null>(null);

  // ─── Voice User Drag & Drop State ───
  // Yetkili kullanıcıların voice kullanıcılarını sürükleyerek başka kanala taşıması.
  // Discord'daki gibi: kullanıcıyı tutup başka voice kanala bırakma.

  /** Sürüklenen voice kullanıcının user_id'si */
  const dragVoiceUserIdRef = useRef<string | null>(null);
  /** Sürüklenen kullanıcının kaynak (source) kanal id'si */
  const dragVoiceSourceChannelRef = useRef<string | null>(null);
  /** Sürüklenen kullanıcı id (CSS vu-dragging class'ı için state — ref render tetiklemez) */
  const [draggingVoiceUserId, setDraggingVoiceUserId] = useState<string | null>(null);
  /** Hover edilen hedef voice kanal id (drop target highlight için) */
  const [voiceDropTargetId, setVoiceDropTargetId] = useState<string | null>(null);

  // ─── Server Drag & Drop State ───
  // Kullanıcının sunucu listesini sürükleyerek sıralaması.
  // Per-user — başkalarını etkilemez, DB'de persist.

  /** Sürüklenen sunucunun id'si */
  const dragServerIdRef = useRef<string | null>(null);
  /** Drop hedefinin üstünde/altında çizgi göstermek için */
  const [serverDropIndicator, setServerDropIndicator] = useState<{
    serverId: string;
    position: "above" | "below";
  } | null>(null);

  function handleServerDragStart(e: React.DragEvent, serverId: string) {
    // Kanal veya voice user sürüklemesiyle çakışmasın
    e.stopPropagation();
    dragServerIdRef.current = serverId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/server", serverId);
  }

  function handleServerDragOver(e: React.DragEvent, serverId: string) {
    // Sadece server sürükleme aktifse işle
    if (!dragServerIdRef.current) return;
    // Kendi üzerine bırakma ihmal
    if (dragServerIdRef.current === serverId) {
      e.preventDefault();
      setServerDropIndicator(null);
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: "above" | "below" = e.clientY < midY ? "above" : "below";
    setServerDropIndicator({ serverId, position: pos });
  }

  function handleServerDragLeave() {
    setServerDropIndicator(null);
  }

  function handleServerDrop(e: React.DragEvent, targetServerId: string) {
    e.preventDefault();
    setServerDropIndicator(null);

    const dragId = dragServerIdRef.current;
    dragServerIdRef.current = null;

    if (!dragId || dragId === targetServerId) return;

    // Mevcut listeyi kopyala
    const ordered = [...servers];
    const dragIdx = ordered.findIndex((s) => s.id === dragId);
    const targetIdx = ordered.findIndex((s) => s.id === targetServerId);
    if (dragIdx === -1 || targetIdx === -1) return;

    // Sürüklenen sunucuyu çıkar
    const [dragged] = ordered.splice(dragIdx, 1);

    // Hedefin yeni index'ini hesapla (splice sonrası kayma)
    let insertIdx = ordered.findIndex((s) => s.id === targetServerId);
    if (insertIdx === -1) insertIdx = ordered.length;

    // Mouse pozisyonuna göre üstte veya altta ekle
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    // Position değerlerini 0'dan başlayarak ata
    const items = ordered.map((s, idx) => ({ id: s.id, position: idx }));
    reorderServers(items).then((ok) => {
      if (!ok) addToast("error", tServers("reorderError"));
    });
  }

  function handleServerDragEnd() {
    dragServerIdRef.current = null;
    setServerDropIndicator(null);
  }

  function handleDragStart(channelId: string, categoryId: string) {
    dragChannelIdRef.current = channelId;
    dragCategoryIdRef.current = categoryId;
  }

  function handleDragOver(e: React.DragEvent, channelId: string, categoryId: string) {
    // Farklı kategori ise drop'a izin verme
    if (dragCategoryIdRef.current !== categoryId) return;
    // Kendi üzerine sürükleme ihmal
    if (dragChannelIdRef.current === channelId) {
      e.preventDefault();
      setDropIndicator(null);
      return;
    }

    e.preventDefault();

    // Mouse'un hedef elemanın üst yarısında mı alt yarısında mı olduğunu hesapla
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: "above" | "below" = e.clientY < midY ? "above" : "below";

    setDropIndicator({ channelId, position: pos });
  }

  function handleDragLeave() {
    setDropIndicator(null);
  }

  function handleDrop(e: React.DragEvent, targetChannelId: string, categoryId: string) {
    e.preventDefault();
    setDropIndicator(null);

    const dragId = dragChannelIdRef.current;
    const dragCatId = dragCategoryIdRef.current;
    dragChannelIdRef.current = null;
    dragCategoryIdRef.current = null;

    if (!dragId || dragCatId !== categoryId || dragId === targetChannelId) return;

    // Kategorideki kanalları bul
    const cat = categories.find((c) => c.category.id === categoryId);
    if (!cat) return;

    // Mevcut sıralı listeyi kopyala
    const ordered = [...cat.channels];
    const dragIdx = ordered.findIndex((ch) => ch.id === dragId);
    const targetIdx = ordered.findIndex((ch) => ch.id === targetChannelId);
    if (dragIdx === -1 || targetIdx === -1) return;

    // Sürüklenen kanalı listeden çıkar
    const [dragged] = ordered.splice(dragIdx, 1);

    // Hedefin yeni index'ini hesapla (splice sonrası index kayması)
    let insertIdx = ordered.findIndex((ch) => ch.id === targetChannelId);
    if (insertIdx === -1) insertIdx = ordered.length;

    // Mouse pozisyonuna göre üstte veya altta ekle
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    // Position değerlerini 0'dan başlayarak ata ve API'ye gönder
    const items = ordered.map((ch, idx) => ({ id: ch.id, position: idx }));
    reorderChannels(items).then((ok) => {
      if (!ok) addToast("error", tCh("reorderError"));
    });
  }

  function handleDragEnd() {
    dragChannelIdRef.current = null;
    dragCategoryIdRef.current = null;
    setDropIndicator(null);
  }

  // ─── Voice User Drag Handlers ───

  /**
   * Voice kullanıcı sürüklemeye başladığında çağrılır.
   * stopPropagation() ile parent'taki kanal reorder drag'ı engellenir —
   * böylece iki drag sistemi birbirine karışmaz.
   */
  function handleVoiceUserDragStart(e: React.DragEvent, userId: string, channelId: string) {
    e.stopPropagation();
    dragVoiceUserIdRef.current = userId;
    dragVoiceSourceChannelRef.current = channelId;
    setDraggingVoiceUserId(userId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/voice-user", userId);
  }

  /** Sürükleme bittiğinde (drop veya iptal) tüm voice drag state'i temizle. */
  function handleVoiceUserDragEnd() {
    dragVoiceUserIdRef.current = null;
    dragVoiceSourceChannelRef.current = null;
    setDraggingVoiceUserId(null);
    setVoiceDropTargetId(null);
  }

  /**
   * Birleşik DragOver — hem kanal reorder hem voice user move'u aynı element üzerinde işler.
   *
   * dragVoiceUserIdRef set ise voice user sürükleniyor demektir:
   *   - Sadece voice kanallar (kaynak kanal hariç) geçerli drop target'tır
   *   - Text kanallar veya kaynak kanal reddedilir
   *
   * Aksi halde mevcut kanal reorder mantığı çalışır.
   */
  function handleChannelDragOver(
    e: React.DragEvent,
    channelId: string,
    channelType: string,
    categoryId: string
  ) {
    if (dragVoiceUserIdRef.current) {
      if (channelType !== "voice" || dragVoiceSourceChannelRef.current === channelId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setVoiceDropTargetId(channelId);
      return;
    }
    handleDragOver(e, channelId, categoryId);
  }

  /**
   * Birleşik DragLeave — cursor kanal elemanının dışına çıktığında çağrılır.
   *
   * relatedTarget kontrolü ile child element geçişlerindeki sahte leave event'leri
   * filtrelenir — cursor hâlâ parent içindeyse highlight kaldırılmaz.
   */
  function handleChannelDragLeave(e: React.DragEvent) {
    if (dragVoiceUserIdRef.current) {
      const related = e.relatedTarget as Node | null;
      if (related && e.currentTarget.contains(related)) return;
      setVoiceDropTargetId(null);
      return;
    }
    handleDragLeave();
  }

  /**
   * Birleşik Drop — voice user move veya kanal reorder'ı gerçekleştirir.
   *
   * Voice user drop'ta: WS üzerinden voice_move_user event'i gönderilir,
   * backend hem kaynak hem hedef kanalda MoveMembers yetkisini kontrol eder.
   */
  function handleChannelDrop(e: React.DragEvent, targetChannelId: string, categoryId: string) {
    if (dragVoiceUserIdRef.current) {
      e.preventDefault();
      const targetUserId = dragVoiceUserIdRef.current;
      dragVoiceUserIdRef.current = null;
      dragVoiceSourceChannelRef.current = null;
      setDraggingVoiceUserId(null);
      setVoiceDropTargetId(null);
      wsSend?.("voice_move_user", {
        target_user_id: targetUserId,
        target_channel_id: targetChannelId,
      });
      return;
    }
    handleDrop(e, targetChannelId, categoryId);
  }

  // ─── Handlers ───

  /** Aktif sunucunun tab'da gösterilecek bilgisi */
  function getActiveServerInfo(): TabServerInfo | undefined {
    if (!activeServerId) return undefined;
    const srv = servers.find((s) => s.id === activeServerId);
    if (!srv) return undefined;
    return { serverId: srv.id, serverName: srv.name, serverIconUrl: srv.icon_url };
  }

  function handleTextChannelClick(channelId: string, channelName: string) {
    selectChannel(channelId);
    openTab(channelId, "text", channelName, getActiveServerInfo());
  }

  function handleVoiceChannelClick(channelId: string, channelName: string) {
    onJoinVoice(channelId);
    openTab(channelId, "voice", channelName, getActiveServerInfo());
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

  /**
   * Sunucu tıklandığında aktif sunucuyu değiştir.
   * Cascade refetch, AppLayout'taki useEffect tarafından otomatik tetiklenir
   * (activeServerId değiştiğinde).
   */
  function handleServerClick(serverId: string) {
    if (serverId === activeServerId) return; // zaten aktif
    setActiveServer(serverId);
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

      {/* ═══ Servers Section — çoklu sunucu, her biri collapsible ═══ */}
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("servers")}
        >
          <Chevron expanded={isSectionExpanded("servers")} />
          <span>{tServers("servers")}</span>
        </button>

        {isSectionExpanded("servers") && (
          <div className="ch-tree-section-body">
            {servers.map((srv) => {
              const srvKey = `srv:${srv.id}`;
              const isActive = srv.id === activeServerId;
              const srvExpanded = isSectionExpanded(srvKey);

              // Sunucu tıklandığında:
              // - Aktif değilse: aktif yap + section'ı expand et (toggle değil!)
              // - Zaten aktifse: sadece expand/collapse toggle
              //
              // Neden toggle değil expand? Çünkü yeni seçilen sunucunun section'ı
              // expandedSections map'inde yoksa varsayılan true kabul edilir.
              // toggleSection bu true'yu false'a çevirir → kanallar gizlenir!
              function handleSrvHeaderClick() {
                if (!isActive) {
                  handleServerClick(srv.id);
                  expandSection(srvKey);
                } else {
                  toggleSection(srvKey);
                }
              }

              const srvDropPos = serverDropIndicator?.serverId === srv.id ? serverDropIndicator.position : null;
              const isSrvDragging = dragServerIdRef.current === srv.id;

              return (
                <div
                  key={srv.id}
                  className={`ch-tree-server-group${isSrvDragging ? " srv-dragging" : ""}${srvDropPos === "above" ? " srv-drop-above" : ""}${srvDropPos === "below" ? " srv-drop-below" : ""}`}
                  draggable
                  onDragStart={(e) => handleServerDragStart(e, srv.id)}
                  onDragOver={(e) => handleServerDragOver(e, srv.id)}
                  onDragLeave={handleServerDragLeave}
                  onDrop={(e) => handleServerDrop(e, srv.id)}
                  onDragEnd={handleServerDragEnd}
                >
                  {/* Sunucu başlığı — ikon + isim + unread badge */}
                  <button
                    className={`ch-tree-server-header${isActive ? " active" : ""}`}
                    onClick={handleSrvHeaderClick}
                  >
                    <Chevron expanded={srvExpanded && isActive} />
                    {srv.icon_url ? (
                      <img
                        src={resolveAssetUrl(srv.icon_url)}
                        alt={srv.name}
                        className="ch-tree-server-icon"
                      />
                    ) : (
                      <span className="ch-tree-server-icon-fallback">
                        {srv.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="ch-tree-server-name">{srv.name}</span>
                    {/* Server-level unread badge — sadece aktif sunucu için göster */}
                    {isActive && (() => {
                      const total = Object.values(unreadCounts).reduce((sum, c) => sum + c, 0);
                      return total > 0 ? (
                        <span className="ch-tree-server-badge">{total > 99 ? "99+" : total}</span>
                      ) : null;
                    })()}
                  </button>

                  {/* Kategoriler + kanallar — sadece aktif sunucu expanded ise */}
                  {isActive && srvExpanded && categories.map((cg) => {
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
                    const isDragging = dragChannelIdRef.current === ch.id;
                    const dropPos = dropIndicator?.channelId === ch.id ? dropIndicator.position : null;

                    return (
                      <div
                        key={ch.id}
                        className={`ch-tree-drag-wrap${isDragging ? " dragging" : ""}${dropPos === "above" ? " drop-above" : ""}${dropPos === "below" ? " drop-below" : ""}`}
                        draggable={canManageChannels}
                        onDragStart={() => handleDragStart(ch.id, cg.category.id)}
                        onDragOver={(e) => handleChannelDragOver(e, ch.id, ch.type, cg.category.id)}
                        onDragLeave={handleChannelDragLeave}
                        onDrop={(e) => handleChannelDrop(e, ch.id, cg.category.id)}
                        onDragEnd={handleDragEnd}
                      >
                        {/* Kanal satırı */}
                        <button
                          className={`ch-tree-item${isActive ? " active" : ""}${!isText ? " voice" : ""}${unread > 0 ? " has-unread" : ""}${voiceDropTargetId === ch.id ? " voice-drop-target" : ""}`}
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
                            {participants.map((p) => {
                              const isMe = p.user_id === currentUser?.id;
                              const isLocalMuted = localMutedUsers[p.user_id] ?? false;
                              const isSpeaking = activeSpeakers[p.user_id] ?? false;

                              return (
                                <div
                                  key={p.user_id}
                                  className={`ch-tree-voice-user${isSpeaking ? " speaking" : ""}${draggingVoiceUserId === p.user_id ? " vu-dragging" : ""}`}
                                  draggable={canMoveMembers && !isMe}
                                  onDragStart={(e) => handleVoiceUserDragStart(e, p.user_id, ch.id)}
                                  onDragEnd={handleVoiceUserDragEnd}
                                  title={canMoveMembers && !isMe ? tVoice("dragToMove") : undefined}
                                  onContextMenu={(e) => {
                                    if (isMe) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setVoiceCtxMenu({
                                      userId: p.user_id,
                                      username: p.username,
                                      displayName: p.display_name,
                                      avatarUrl: p.avatar_url,
                                      x: e.clientX,
                                      y: e.clientY,
                                    });
                                  }}
                                >
                                  <Avatar
                                    name={p.display_name || p.username}
                                    avatarUrl={p.avatar_url}
                                    size={22}
                                    isCircle
                                  />
                                  <span className="ch-tree-vu-name">{p.display_name || p.username}</span>
                                  {/* Durum ikonları: server deafen > server mute > local mute > streaming > self deafen > self mute > online dot */}
                                  <span className="ch-tree-vu-icons">
                                    {p.is_server_deafened && (
                                      <svg className="ch-tree-vu-icon ch-tree-vu-server-deafen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-label={tVoice("serverDeafened")}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                                      </svg>
                                    )}
                                    {p.is_server_muted && (
                                      <svg className="ch-tree-vu-icon ch-tree-vu-server-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-label={tVoice("serverMuted")}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                                      </svg>
                                    )}
                                    {!isMe && isLocalMuted && (
                                      <svg className="ch-tree-vu-icon ch-tree-vu-local-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-label={tVoice("localMuted")}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                                      </svg>
                                    )}
                                    {p.is_streaming && (
                                      <button
                                        className={`ch-tree-vu-icon ch-tree-vu-stream${watchingScreenShares[p.user_id] ? " watching" : ""}`}
                                        onClick={(e) => { e.stopPropagation(); toggleWatchScreenShare(p.user_id); }}
                                        title={watchingScreenShares[p.user_id] ? tVoice("stopWatching") : tVoice("watchScreenShare")}
                                      >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                        </svg>
                                      </button>
                                    )}
                                    {p.is_deafened ? (
                                      <svg className="ch-tree-vu-icon ch-tree-vu-deafen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
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
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
                </div>
              );
            })}

            {/* + Sunucu Ekle butonu — her zaman en altta */}
            <button
              className="ch-tree-item ch-tree-add-server"
              onClick={() => setShowAddServer(true)}
            >
              <span className="ch-tree-icon">+</span>
              <span className="ch-tree-label">{tServers("addServer")}</span>
            </button>
          </div>
        )}
      </div>

      {/* Add Server Modal */}
      {showAddServer && (
        <AddServerModal
          onClose={() => setShowAddServer(false)}
        />
      )}

      {/* Voice User Context Menu — sağ tık menüsü (portal ile body'ye render edilir) */}
      {voiceCtxMenu && (
        <VoiceUserContextMenu
          userId={voiceCtxMenu.userId}
          username={voiceCtxMenu.username}
          displayName={voiceCtxMenu.displayName}
          avatarUrl={voiceCtxMenu.avatarUrl}
          position={{ x: voiceCtxMenu.x, y: voiceCtxMenu.y }}
          onClose={() => setVoiceCtxMenu(null)}
        />
      )}
    </div>
  );
}

export default ChannelTree;
