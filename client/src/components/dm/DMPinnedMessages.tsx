/**
 * DMPinnedMessages — DM kanalının pinlenmiş mesajlarını gösteren popup panel.
 *
 * Channel PinnedMessages'ten farklı olarak:
 * - pinStore yerine dmStore.getPinnedMessages kullanır
 * - PinnedMessage wrapper tipi yerine doğrudan DMMessage kullanır
 * - DM'de her iki kullanıcı da unpin yapabilir (canManageMessages: true)
 *
 * CSS class'ları: PinnedMessages ile aynı — .pinned-panel, .pinned-header, vb.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import Avatar from "../shared/Avatar";
import type { DMMessage } from "../../types";

type DMPinnedMessagesProps = {
  channelId: string;
  onClose: () => void;
};

function DMPinnedMessages({ channelId, onClose }: DMPinnedMessagesProps) {
  const { t } = useTranslation("chat");
  const getPinnedMessages = useDMStore((s) => s.getPinnedMessages);
  const unpinMessage = useDMStore((s) => s.unpinMessage);

  const [pins, setPins] = useState<DMMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      const result = await getPinnedMessages(channelId);
      if (!cancelled) {
        setPins(result);
        setIsLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [channelId, getPinnedMessages]);

  const handleUnpin = useCallback(
    async (messageId: string) => {
      await unpinMessage(channelId, messageId);
      // Listeden kaldır (WS event ile de gelecek ama instant feedback)
      setPins((prev) => prev.filter((m) => m.id !== messageId));
    },
    [channelId, unpinMessage]
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
          pins.map((msg) => {
            const author = msg.author;
            const displayName = author?.display_name ?? author?.username ?? "Unknown";

            return (
              <div key={msg.id} className="pinned-item">
                <div className="pinned-item-header">
                  <Avatar
                    name={displayName}
                    avatarUrl={author?.avatar_url ?? undefined}
                    size={20}
                  />
                  <span className="pinned-item-author">{displayName}</span>
                  <span className="pinned-item-time">
                    {formatDate(msg.created_at)}
                  </span>
                </div>

                <div className="pinned-item-content">
                  {msg.content ?? ""}
                </div>

                <button
                  onClick={() => handleUnpin(msg.id)}
                  className="pinned-item-unpin"
                  title={t("unpinMessage")}
                >
                  <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default DMPinnedMessages;
