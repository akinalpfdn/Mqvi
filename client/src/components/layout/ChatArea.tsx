/**
 * ChatArea — Orta panel: kanal başlığı, mesajlar ve mesaj input.
 *
 * Discord referans spacing'leri:
 * - Header: h-header(48px), hash + isim + divider + topic
 * - Messages: geniş padding, alt hizalı
 * - Welcome: büyük icon, başlık, açıklama
 * - Input: rounded-lg, 44px yükseklik, generous padding
 */

import { useTranslation } from "react-i18next";

function ChatArea() {
  const { t } = useTranslation("chat");
  const channelName = "general";

  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* ─── Channel Header ─── */}
      <div className="flex h-header shrink-0 items-center border-b border-background-tertiary px-4 shadow-sm">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl leading-none text-text-muted">#</span>
          <h3 className="text-[15px] font-semibold text-text-primary">{channelName}</h3>
        </div>

        {/* Divider */}
        <div className="mx-4 h-6 w-px bg-background-tertiary" />

        {/* Channel topic / description */}
        <p className="truncate text-sm text-text-muted">
          {t("channelStart", { channel: channelName })}
        </p>
      </div>

      {/* ─── Messages Area ─── */}
      <div className="flex flex-1 flex-col justify-end overflow-y-auto">
        {/* Welcome placeholder — Faz 2'de MessageList component'i gelecek */}
        <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
          <div className="mb-4 flex h-[76px] w-[76px] items-center justify-center rounded-full bg-surface">
            <span className="text-[42px] leading-none text-text-muted">#</span>
          </div>
          <h2 className="mb-2 text-[32px] font-bold leading-tight text-text-primary">
            {t("welcomeChannel", { channel: channelName })}
          </h2>
          <p className="max-w-lg text-base leading-relaxed text-text-muted">
            {t("channelStart", { channel: channelName })}
          </p>
        </div>
      </div>

      {/* ─── Message Input ─── */}
      <div className="px-4 pb-6 pt-1">
        <div className="flex items-center rounded-lg bg-input px-4 py-1">
          {/* File upload button */}
          <button className="mr-4 flex h-11 shrink-0 items-center text-text-muted transition-colors hover:text-text-secondary">
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>

          <input
            type="text"
            placeholder={t("messagePlaceholder", { channel: channelName })}
            className="h-11 flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-muted"
            disabled
          />
        </div>
      </div>
    </div>
  );
}

export default ChatArea;
