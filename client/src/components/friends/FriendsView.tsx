/**
 * FriendsView — Ana arkadaş yönetim sayfası.
 *
 * Tab'lar: Online, All, Pending, Add Friend
 * Arama: Online/All tab'larında isim/username ile filtreleme
 *
 * PanelView'dan "friends" tab tipiyle render edilir.
 * Tüm arkadaşlık CRUD işlemlerini içerir.
 *
 * CSS class'ları: .friends-view, .fv-header, .fv-tabs, .fv-tab,
 * .fv-tab.active, .fv-content, .fv-list, .fv-empty, .fv-search,
 * .fv-search-input
 */

import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useFriendStore } from "../../stores/friendStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import FriendItem from "./FriendItem";
import FriendRequestForm from "./FriendRequestForm";
import type { FriendshipWithUser } from "../../types";

type FriendsTab = "online" | "all" | "pending" | "add";

function FriendsView() {
  const { t } = useTranslation("common");
  const [activeTab, setActiveTab] = useState<FriendsTab>("online");
  const [searchQuery, setSearchQuery] = useState("");

  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);
  const isLoading = useFriendStore((s) => s.isLoading);
  const fetchFriends = useFriendStore((s) => s.fetchFriends);
  const fetchRequests = useFriendStore((s) => s.fetchRequests);
  const acceptRequest = useFriendStore((s) => s.acceptRequest);
  const declineRequest = useFriendStore((s) => s.declineRequest);
  const removeFriend = useFriendStore((s) => s.removeFriend);

  const createOrGetChannel = useDMStore((s) => s.createOrGetChannel);
  const selectDM = useDMStore((s) => s.selectDM);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const openTab = useUIStore((s) => s.openTab);
  const confirmOpen = useConfirmStore((s) => s.open);
  const initiateCall = useP2PCallStore((s) => s.initiateCall);

  // İlk mount'ta verileri çek
  useEffect(() => {
    fetchFriends();
    fetchRequests();
  }, [fetchFriends, fetchRequests]);

  // Online arkadaşları filtrele (online, idle, dnd)
  const onlineFriends = friends.filter(
    (f) => f.user_status !== "offline"
  );

  /**
   * Arama filtresi — display_name veya username üzerinde case-insensitive arama.
   * useMemo ile gereksiz yeniden hesaplamayı önler.
   */
  const query = searchQuery.trim().toLowerCase();

  const filteredOnline = useMemo(
    () =>
      query
        ? onlineFriends.filter(
            (f) =>
              (f.display_name ?? "").toLowerCase().includes(query) ||
              f.username.toLowerCase().includes(query)
          )
        : onlineFriends,
    [onlineFriends, query]
  );

  const filteredAll = useMemo(
    () =>
      query
        ? friends.filter(
            (f) =>
              (f.display_name ?? "").toLowerCase().includes(query) ||
              f.username.toLowerCase().includes(query)
          )
        : friends,
    [friends, query]
  );

  /** DM aç/oluştur ve tab'a yönlendir */
  async function handleSendMessage(userId: string, displayName: string) {
    const channelId = await createOrGetChannel(userId);
    if (channelId) {
      selectDM(channelId);
      openTab(channelId, "dm", displayName);
      fetchMessages(channelId);
    }
  }

  /** Arkadaş silme — onay dialogu ile */
  async function handleRemoveFriend(friendship: FriendshipWithUser) {
    const name = friendship.display_name ?? friendship.username;
    const ok = await confirmOpen({
      title: t("friendRemove"),
      message: t("friendRemoveConfirm", { username: name }),
      confirmLabel: t("friendRemove"),
      danger: true,
    });
    if (ok) removeFriend(friendship.user_id);
  }

  /** Tab değiştirildiğinde arama sıfırlanır */
  function handleTabChange(tab: FriendsTab) {
    setActiveTab(tab);
    setSearchQuery("");
  }

  function renderList(list: FriendshipWithUser[], type: "friend" | "incoming" | "outgoing") {
    if (list.length === 0) {
      return (
        <div className="fv-empty">
          {query
            ? t("noResults")
            : type === "friend"
              ? t("noFriendsYet")
              : type === "incoming"
                ? t("noIncomingRequests")
                : t("noOutgoingRequests")}
        </div>
      );
    }

    return (
      <div className="fv-list">
        {list.map((item) => (
          <FriendItem
            key={item.id}
            friendship={item}
            type={type}
            onAccept={type === "incoming" ? () => acceptRequest(item.id) : undefined}
            onDecline={type === "incoming" || type === "outgoing" ? () => declineRequest(item.id) : undefined}
            onRemove={type === "friend" ? () => handleRemoveFriend(item) : undefined}
            onSendMessage={
              type === "friend"
                ? () => handleSendMessage(item.user_id, item.display_name ?? item.username)
                : undefined
            }
            onVoiceCall={type === "friend" ? () => initiateCall(item.user_id, "voice") : undefined}
            onVideoCall={type === "friend" ? () => initiateCall(item.user_id, "video") : undefined}
          />
        ))}
      </div>
    );
  }

  /** Arama çubuğu — Online ve All tab'larında gösterilir */
  const showSearch = activeTab === "online" || activeTab === "all";

  return (
    <div className="friends-view">
      {/* Header — tab navigation */}
      <div className="fv-header">
        <h2 className="fv-title">{t("friends")}</h2>
        <div className="fv-tabs">
          <button
            className={`fv-tab${activeTab === "online" ? " active" : ""}`}
            onClick={() => handleTabChange("online")}
          >
            {t("friendsOnline")}
            {onlineFriends.length > 0 && (
              <span className="fv-tab-count">{onlineFriends.length}</span>
            )}
          </button>
          <button
            className={`fv-tab${activeTab === "all" ? " active" : ""}`}
            onClick={() => handleTabChange("all")}
          >
            {t("friendsAll")}
            {friends.length > 0 && (
              <span className="fv-tab-count">{friends.length}</span>
            )}
          </button>
          <button
            className={`fv-tab${activeTab === "pending" ? " active" : ""}`}
            onClick={() => handleTabChange("pending")}
          >
            {t("friendsPending")}
            {(incoming.length + outgoing.length) > 0 && (
              <span className="fv-tab-count">{incoming.length + outgoing.length}</span>
            )}
          </button>
          <button
            className={`fv-tab fv-tab-add${activeTab === "add" ? " active" : ""}`}
            onClick={() => handleTabChange("add")}
          >
            {t("addFriend")}
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="fv-content">
        {/* Arama çubuğu */}
        {showSearch && (
          <div className="fv-search">
            <input
              className="fv-search-input"
              type="text"
              placeholder={t("friendSearchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        )}

        {isLoading ? (
          <div className="fv-empty">{t("loading")}</div>
        ) : activeTab === "online" ? (
          renderList(filteredOnline, "friend")
        ) : activeTab === "all" ? (
          renderList(filteredAll, "friend")
        ) : activeTab === "pending" ? (
          <div>
            {incoming.length > 0 && (
              <div className="fv-pending-section">
                <h3 className="fv-pending-title">{t("friendsIncoming")} — {incoming.length}</h3>
                {renderList(incoming, "incoming")}
              </div>
            )}
            {outgoing.length > 0 && (
              <div className="fv-pending-section">
                <h3 className="fv-pending-title">{t("friendsOutgoing")} — {outgoing.length}</h3>
                {renderList(outgoing, "outgoing")}
              </div>
            )}
            {incoming.length === 0 && outgoing.length === 0 && (
              <div className="fv-empty">{t("noPendingRequests")}</div>
            )}
          </div>
        ) : (
          <FriendRequestForm />
        )}
      </div>
    </div>
  );
}

export default FriendsView;
