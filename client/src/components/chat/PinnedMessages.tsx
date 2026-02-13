/**
 * PinnedMessages — Kanalın pinlenmiş mesajlarını gösteren popup panel.
 *
 * CSS class'ları: .pinned-panel, .pinned-header, .pinned-close,
 * .pinned-list, .pinned-item, .pinned-item-meta, .pinned-item-content
 *
 * Kanal header'ındaki pin ikonuna tıklayınca açılır.
 * Açıldığında ilgili kanalın pinlerini fetch eder.
 * WS event'leri ile gerçek zamanlı güncellenir (pinStore).
 */

import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { usePinStore } from "../../stores/pinStore";
import { useMemberStore } from "../../stores/memberStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { useAuthStore } from "../../stores/authStore";
import Avatar from "../shared/Avatar";

type PinnedMessagesProps = {
  channelId: string;
  onClose: () => void;
};

function PinnedMessages({ channelId, onClose }: PinnedMessagesProps) {
  const { t } = useTranslation("chat");
  const fetchPins = usePinStore((s) => s.fetchPins);
  const getPinsForChannel = usePinStore((s) => s.getPinsForChannel);
  const unpinAction = usePinStore((s) => s.unpin);
  const isLoading = usePinStore((s) => s.isLoading);
  const members = useMemberStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);

  const pins = getPinsForChannel(channelId);

  // Mevcut kullanıcının ManageMessages yetkisi
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageMessages = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageMessages)
    : false;

  useEffect(() => {
    fetchPins(channelId);
  }, [channelId, fetchPins]);

  const handleUnpin = useCallback(
    async (messageId: string) => {
      await unpinAction(channelId, messageId);
    },
    [channelId, unpinAction]
  );

  /** Timestamp formatı */
  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString([], {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <div className="pinned-panel">
      {/* Header */}
      <div className="pinned-header">
        <span className="pinned-header-title">{t("pinnedMessages")}</span>
        <button onClick={onClose} className="pinned-close">
          <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Pin listesi */}
      <div className="pinned-list">
        {isLoading ? (
          <p className="pinned-empty">{t("noPinnedMessages")}</p>
        ) : pins.length === 0 ? (
          <p className="pinned-empty">{t("noPinnedMessages")}</p>
        ) : (
          pins.map((pin) => {
            const author = pin.message?.author;
            const displayName = author?.display_name ?? author?.username ?? "Unknown";

            return (
              <div key={pin.id} className="pinned-item">
                {/* Yazar avatar + meta */}
                <div className="pinned-item-header">
                  <Avatar
                    name={displayName}
                    avatarUrl={author?.avatar_url ?? undefined}
                    size={20}
                  />
                  <span className="pinned-item-author">{displayName}</span>
                  <span className="pinned-item-time">
                    {formatDate(pin.message?.created_at ?? pin.created_at)}
                  </span>
                </div>

                {/* Mesaj içeriği */}
                <div className="pinned-item-content">
                  {pin.message?.content ?? ""}
                </div>

                {/* Unpin butonu — ManageMessages yetkisi gerekir */}
                {canManageMessages && (
                  <button
                    onClick={() => handleUnpin(pin.message_id)}
                    className="pinned-item-unpin"
                    title={t("unpinMessage")}
                  >
                    <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default PinnedMessages;
