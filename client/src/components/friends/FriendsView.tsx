/**
 * FriendsView — Ana arkadaş yönetim sayfası.
 *
 * Tab'lar: Online, All, Pending, Add Friend
 *
 * PanelView'dan "friends" tab tipiyle render edilir.
 * Tüm arkadaşlık CRUD işlemlerini içerir.
 *
 * CSS class'ları: .friends-view, .fv-header, .fv-tabs, .fv-tab,
 * .fv-tab.active, .fv-content, .fv-list, .fv-empty
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useFriendStore } from "../../stores/friendStore";
import FriendItem from "./FriendItem";
import FriendRequestForm from "./FriendRequestForm";
import type { FriendshipWithUser } from "../../types";

type FriendsTab = "online" | "all" | "pending" | "add";

function FriendsView() {
  const { t } = useTranslation("common");
  const [activeTab, setActiveTab] = useState<FriendsTab>("online");

  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);
  const isLoading = useFriendStore((s) => s.isLoading);
  const fetchFriends = useFriendStore((s) => s.fetchFriends);
  const fetchRequests = useFriendStore((s) => s.fetchRequests);
  const acceptRequest = useFriendStore((s) => s.acceptRequest);
  const declineRequest = useFriendStore((s) => s.declineRequest);
  const removeFriend = useFriendStore((s) => s.removeFriend);

  // İlk mount'ta verileri çek
  useEffect(() => {
    fetchFriends();
    fetchRequests();
  }, [fetchFriends, fetchRequests]);

  // Online arkadaşları filtrele (online, idle, dnd)
  const onlineFriends = friends.filter(
    (f) => f.user_status !== "offline"
  );

  function renderList(list: FriendshipWithUser[], type: "friend" | "incoming" | "outgoing") {
    if (list.length === 0) {
      return (
        <div className="fv-empty">
          {type === "friend"
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
            onRemove={type === "friend" ? () => removeFriend(item.user_id) : undefined}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="friends-view">
      {/* Header — tab navigation */}
      <div className="fv-header">
        <h2 className="fv-title">{t("friends")}</h2>
        <div className="fv-tabs">
          <button
            className={`fv-tab${activeTab === "online" ? " active" : ""}`}
            onClick={() => setActiveTab("online")}
          >
            {t("friendsOnline")}
            {onlineFriends.length > 0 && (
              <span className="fv-tab-count">{onlineFriends.length}</span>
            )}
          </button>
          <button
            className={`fv-tab${activeTab === "all" ? " active" : ""}`}
            onClick={() => setActiveTab("all")}
          >
            {t("friendsAll")}
            {friends.length > 0 && (
              <span className="fv-tab-count">{friends.length}</span>
            )}
          </button>
          <button
            className={`fv-tab${activeTab === "pending" ? " active" : ""}`}
            onClick={() => setActiveTab("pending")}
          >
            {t("friendsPending")}
            {(incoming.length + outgoing.length) > 0 && (
              <span className="fv-tab-count">{incoming.length + outgoing.length}</span>
            )}
          </button>
          <button
            className={`fv-tab fv-tab-add${activeTab === "add" ? " active" : ""}`}
            onClick={() => setActiveTab("add")}
          >
            {t("addFriend")}
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="fv-content">
        {isLoading ? (
          <div className="fv-empty">{t("loading")}</div>
        ) : activeTab === "online" ? (
          renderList(onlineFriends, "friend")
        ) : activeTab === "all" ? (
          renderList(friends, "friend")
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
