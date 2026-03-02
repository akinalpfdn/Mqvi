/**
 * InviteFriendsModal — Sunucuya arkadaş davet etme modal'ı.
 *
 * Akış:
 * 1. Arkadaş listesi checkbox ile gösterilir
 * 2. Kullanıcı arkadaşlarını seçer
 * 3. "Davet Gönder" butonuna basar
 * 4. Backend'de invite kodu oluşturulur (max_uses=0, expires_in=0 — sınırsız)
 * 5. Her seçili arkadaşa DM ile davet URL'si gönderilir
 * 6. Başarı toast'u gösterilir
 *
 * Ek olarak: Üstte "Link Kopyala" butonu — WhatsApp, Telegram vb.
 * üzerinden paylaşmak için invite URL'sini panoya kopyalar.
 *
 * CSS class'ları: modal-backdrop, modal-card, .invite-friends-*
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useFriendStore } from "../../stores/friendStore";
import { useServerStore } from "../../stores/serverStore";
import { useInviteStore } from "../../stores/inviteStore";
import { useDMStore } from "../../stores/dmStore";
import { useToastStore } from "../../stores/toastStore";
import { getInviteUrl } from "../../utils/constants";
import type { FriendshipWithUser } from "../../types";
import Avatar from "../shared/Avatar";

type InviteFriendsModalProps = {
  serverId: string;
  serverName: string;
  onClose: () => void;
};

function InviteFriendsModal({ serverId, serverName, onClose }: InviteFriendsModalProps) {
  const { t } = useTranslation("servers");
  const friends = useFriendStore((s) => s.friends);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const createInvite = useInviteStore((s) => s.createInvite);
  const createOrGetChannel = useDMStore((s) => s.createOrGetChannel);
  const sendMessage = useDMStore((s) => s.sendMessage);
  const addToast = useToastStore((s) => s.addToast);

  /** Seçilen arkadaş user_id'leri */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Gönderim durumu */
  const [isSending, setIsSending] = useState(false);
  /** Gönderim ilerlemesi */
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  /** Link kopyalama durumu */
  const [isCopying, setIsCopying] = useState(false);

  // Escape ile kapatma
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSending) onClose();
    },
    [onClose, isSending],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [handleKeyDown]);

  /** Arkadaş seçim toggle'ı */
  function toggleFriend(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }

  /** Tüm arkadaşları seç/kaldır */
  function toggleAll() {
    if (selected.size === friends.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(friends.map((f) => f.user_id)));
    }
  }

  /**
   * Link kopyalama — WhatsApp/Telegram paylaşımı için.
   * Invite kodu oluşturur ve URL'yi panoya kopyalar.
   */
  async function handleCopyLink() {
    if (isCopying) return;
    setIsCopying(true);

    // Doğru sunucu context'inde invite oluşturulmasını garantile
    const currentActive = useServerStore.getState().activeServerId;
    if (currentActive !== serverId) {
      setActiveServer(serverId);
    }

    const invite = await createInvite(0, 0);
    if (!invite) {
      addToast("error", t("inviteCreateFailed"));
      setIsCopying(false);
      return;
    }

    try {
      await navigator.clipboard.writeText(getInviteUrl(invite.code));
      addToast("success", t("inviteLinkCopied"));
    } catch {
      addToast("error", t("inviteCreateFailed"));
    }
    setIsCopying(false);
  }

  /**
   * Davet gönderimi:
   * 1. Invite kodu oluştur (unlimited uses, no expiry)
   * 2. Her seçili arkadaş için DM kanalı aç/getir
   * 3. DM mesajı gönder
   */
  async function handleSendInvites() {
    if (selected.size === 0 || isSending) return;

    setIsSending(true);
    setProgress({ sent: 0, total: selected.size });

    // inviteStore activeServerId'ye bağlı — doğru sunucuda oluşturulmasını garantile
    const currentActive = useServerStore.getState().activeServerId;
    if (currentActive !== serverId) {
      setActiveServer(serverId);
    }

    // 1. Invite kodu oluştur — sınırsız kullanım, süresiz
    const invite = await createInvite(0, 0);
    if (!invite) {
      addToast("error", t("inviteCreateFailed"));
      setIsSending(false);
      return;
    }

    const inviteContent = getInviteUrl(invite.code);
    let sentCount = 0;

    // 2. Her arkadaşa sıralı gönder (rate limit koruması)
    for (const userId of selected) {
      const channelId = await createOrGetChannel(userId);
      if (channelId) {
        await sendMessage(channelId, inviteContent);
        sentCount++;
        setProgress({ sent: sentCount, total: selected.size });
      }
    }

    // 3. Sonuç
    addToast("success", t("invitesSent", { count: sentCount }));
    setIsSending(false);
    onClose();
  }

  /** Arkadaş kartı render'ı */
  function renderFriend(friend: FriendshipWithUser) {
    const isChecked = selected.has(friend.user_id);
    const name = friend.display_name ?? friend.username;

    return (
      <button
        key={friend.user_id}
        className={`invite-friend-item${isChecked ? " checked" : ""}`}
        onClick={() => toggleFriend(friend.user_id)}
        disabled={isSending}
      >
        <span className={`invite-friend-check${isChecked ? " checked" : ""}`}>
          {isChecked && "\u2713"}
        </span>
        <Avatar
          name={name}
          avatarUrl={friend.avatar_url ?? undefined}
          size={32}
          isCircle
        />
        <span className="invite-friend-name">{name}</span>
        <span className="invite-friend-username">@{friend.username}</span>
      </button>
    );
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSending) onClose();
      }}
    >
      <div className="modal-card invite-friends-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{t("inviteFriends")}</h2>
            <p className="invite-friends-desc">
              {t("inviteFriendsDesc", { server: serverName })}
            </p>
          </div>
          <button onClick={onClose} className="toast-close" disabled={isSending}>
            &#x2715;
          </button>
        </div>

        {/* Link Kopyala — dış paylaşım için */}
        <div className="invite-friends-copy-section">
          <button
            className="invite-friends-copy-btn"
            onClick={handleCopyLink}
            disabled={isCopying || isSending}
          >
            {isCopying ? "..." : t("copyInviteLink")}
          </button>
          <span className="invite-friends-copy-hint">{t("copyInviteLinkHint")}</span>
        </div>

        {/* Separator */}
        <div className="invite-friends-separator">
          <span className="invite-friends-separator-line" />
          <span className="invite-friends-separator-text">{t("orSeparator")}</span>
          <span className="invite-friends-separator-line" />
        </div>

        {/* Friend list */}
        <div className="invite-friends-body">
          {friends.length === 0 ? (
            <div className="invite-friends-empty">
              <p>{t("noFriends")}</p>
            </div>
          ) : (
            <>
              {/* Select all toggle */}
              <button
                className="invite-friends-select-all"
                onClick={toggleAll}
                disabled={isSending}
              >
                {selected.size === friends.length
                  ? t("deselectAll")
                  : t("selectAll")}
                <span className="invite-friends-count">
                  {selected.size}/{friends.length}
                </span>
              </button>

              {/* Scrollable friend list */}
              <div className="invite-friends-list">
                {friends.map(renderFriend)}
              </div>
            </>
          )}
        </div>

        {/* Footer — send button */}
        <div className="invite-friends-footer">
          {isSending ? (
            <div className="invite-friends-progress">
              <span>{t("sendingInvites", { sent: progress.sent, total: progress.total })}</span>
              <div className="invite-friends-progress-bar">
                <div
                  className="invite-friends-progress-fill"
                  style={{
                    width: progress.total > 0
                      ? `${(progress.sent / progress.total) * 100}%`
                      : "0%",
                  }}
                />
              </div>
            </div>
          ) : (
            <button
              className="invite-friends-send"
              onClick={handleSendInvites}
              disabled={selected.size === 0}
            >
              {t("sendInvites")} {selected.size > 0 && `(${selected.size})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default InviteFriendsModal;
