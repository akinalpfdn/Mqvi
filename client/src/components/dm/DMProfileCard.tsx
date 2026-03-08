/** DMProfileCard — DM user profile popover (no server context). */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Avatar from "../shared/Avatar";
import BadgePill from "../shared/BadgePill";
import { useUserBadges } from "../../hooks/useUserBadges";
import { useDMStore } from "../../stores/dmStore";
import { useFriendStore } from "../../stores/friendStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useUIStore } from "../../stores/uiStore";
import type { DMChannelWithUser } from "../../types";

type DMProfileCardProps = {
  dm: DMChannelWithUser;
  position: { top: number; left: number };
  onClose: () => void;
};

function DMProfileCard({ dm, position, onClose }: DMProfileCardProps) {
  const { t } = useTranslation("dm");
  const { t: tCommon } = useTranslation("common");
  const cardRef = useRef<HTMLDivElement>(null);

  const selectDM = useDMStore((s) => s.selectDM);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const openTab = useUIStore((s) => s.openTab);

  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);
  const sendRequest = useFriendStore((s) => s.sendRequest);
  const removeFriend = useFriendStore((s) => s.removeFriend);
  const acceptRequest = useFriendStore((s) => s.acceptRequest);
  const declineRequest = useFriendStore((s) => s.declineRequest);

  const initiateCall = useP2PCallStore((s) => s.initiateCall);

  const user = dm.other_user;
  const name = user.display_name || user.username;
  const userBadges = useUserBadges(user.id);

  // Friendship state
  const isFriend = friends.some((f) => f.user_id === user.id);
  const outReq = outgoing.find((r) => r.user_id === user.id);
  const inReq = incoming.find((r) => r.user_id === user.id);

  // Close on click-outside
  useEffect(() => {
    let frameId: number;

    function handleClick(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    frameId = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });

    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Clamp position to viewport
  useEffect(() => {
    if (!cardRef.current) return;

    const card = cardRef.current;
    const rect = card.getBoundingClientRect();
    const viewportH = window.innerHeight;

    let adjustedTop = position.top;
    if (adjustedTop + rect.height > viewportH - 8) {
      adjustedTop = viewportH - rect.height - 8;
    }

    card.style.top = `${adjustedTop}px`;
    card.style.left = `${position.left}px`;
  }, [position]);

  function handleSendMessage() {
    selectDM(dm.id);
    openTab(dm.id, "dm", name);
    clearDMUnread(dm.id);
    fetchMessages(dm.id);
    onClose();
  }

  function handleVoiceCall() {
    initiateCall(user.id, "voice");
    onClose();
  }

  function handleAddFriend() {
    sendRequest(user.username);
    onClose();
  }

  function handleRemoveFriend() {
    removeFriend(user.id);
    onClose();
  }

  function handleAcceptRequest() {
    if (inReq) acceptRequest(inReq.id);
    onClose();
  }

  function handleCancelRequest() {
    if (outReq) declineRequest(outReq.id);
    onClose();
  }

  return (
    <>
      <div className="dm-profile-backdrop" onClick={onClose} />
      <div
        ref={cardRef}
        className="dm-profile-card"
        style={{ top: position.top, left: position.left }}
      >
        {/* Banner */}
        <div className="dm-profile-banner" />

        {/* Avatar */}
        <div className="dm-profile-avatar">
          <Avatar
            name={name}
            avatarUrl={user.avatar_url}
            size={64}
            isCircle
          />
        </div>

        {/* Body */}
        <div className="dm-profile-body">
          <div className="dm-profile-name">{name}</div>
          <div className="dm-profile-username">@{user.username}</div>
          {user.custom_status && (
            <div className="dm-profile-status">{user.custom_status}</div>
          )}

          {/* User badges */}
          {userBadges.length > 0 && (
            <div className="dm-profile-badges">
              {userBadges.map((ub) =>
                ub.badge ? <BadgePill key={ub.id} badge={ub.badge} size="md" /> : null
              )}
            </div>
          )}

          <div className="dm-profile-divider" />

          {/* Actions */}
          <div className="dm-profile-actions">
            <button
              className="dm-profile-btn dm-profile-btn-primary"
              onClick={handleSendMessage}
            >
              {tCommon("sendMessage")}
            </button>
            <button
              className="dm-profile-btn dm-profile-btn-secondary"
              onClick={handleVoiceCall}
            >
              {t("voiceCall")}
            </button>
          </div>

          {/* Friend action */}
          <div className="dm-profile-actions" style={{ marginTop: 8 }}>
            {isFriend ? (
              <button
                className="dm-profile-btn dm-profile-btn-danger"
                onClick={handleRemoveFriend}
              >
                {t("removeFriend")}
              </button>
            ) : inReq ? (
              <button
                className="dm-profile-btn dm-profile-btn-primary"
                onClick={handleAcceptRequest}
              >
                {t("acceptRequest")}
              </button>
            ) : outReq ? (
              <button
                className="dm-profile-btn dm-profile-btn-secondary"
                onClick={handleCancelRequest}
              >
                {t("cancelRequest")}
              </button>
            ) : (
              <button
                className="dm-profile-btn dm-profile-btn-secondary"
                onClick={handleAddFriend}
              >
                {t("addFriend")}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default DMProfileCard;
