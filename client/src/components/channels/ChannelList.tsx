/**
 * ChannelList — Sidebar'da gösterilen dinamik kanal listesi.
 *
 * Kategoriler collapsible (tıkla → aç/kapa) olarak gösterilir.
 * channelStore'dan veri alır — WebSocket event'leri ile gerçek zamanlı güncellenir.
 *
 * İlk mount'da fetchChannels çağrılır.
 * Kanal tıklandığında channelStore.selectChannel ile seçilir.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import { useVoiceStore } from "../../stores/voiceStore";
import ChannelItem from "./ChannelItem";

type ChannelListProps = {
  onJoinVoice: (channelId: string) => Promise<void>;
};

function ChannelList({ onJoinVoice }: ChannelListProps) {
  const { t } = useTranslation("channels");
  const categories = useChannelStore((s) => s.categories);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const isLoading = useChannelStore((s) => s.isLoading);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const voiceStates = useVoiceStore((s) => s.voiceStates);

  /** Kapatılmış (collapsed) kategorilerin ID setini tutar */
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    new Set()
  );

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  /** Kategori başlığına tıklanınca aç/kapa toggle */
  function toggleCategory(categoryId: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-text-muted">...</span>
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <span className="text-sm text-text-muted">{t("noChannels")}</span>
      </div>
    );
  }

  return (
    <nav className="flex-1 overflow-y-auto pb-4 pt-3">
      {categories.map(({ category, channels }) => {
        const isCollapsed = collapsedCategories.has(category.id);

        return (
          <div key={category.id}>
            {/* Kategori başlığı — tıklayınca collapse toggle */}
            <div className="px-4 pb-1 pt-4">
              <button
                onClick={() => toggleCategory(category.id)}
                className="flex w-full items-center gap-1 text-[11px] font-bold uppercase tracking-[0.02em] text-text-muted transition-colors hover:text-text-secondary"
              >
                <svg
                  className={`h-3 w-3 shrink-0 transition-transform ${
                    isCollapsed ? "-rotate-90" : ""
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
                {category.name}
              </button>
            </div>

            {/* Kanallar — collapse durumunda gizle */}
            {!isCollapsed &&
              channels.map((channel) => (
                <ChannelItem
                  key={channel.id}
                  channel={channel}
                  isActive={
                    channel.type === "voice"
                      ? channel.id === currentVoiceChannelId
                      : channel.id === selectedChannelId
                  }
                  voiceParticipants={
                    channel.type === "voice"
                      ? voiceStates[channel.id] ?? []
                      : []
                  }
                  onClick={() => {
                    if (channel.type === "voice") {
                      // Voice kanal: katıl + seç (görüntüleme)
                      onJoinVoice(channel.id);
                      selectChannel(channel.id);
                    } else {
                      // Text kanal: sadece seç
                      selectChannel(channel.id);
                    }
                  }}
                />
              ))}
          </div>
        );
      })}
    </nav>
  );
}

export default ChannelList;
