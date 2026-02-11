/**
 * ChatArea — Orta panel: kanal başlığı, mesajlar ve mesaj input.
 *
 * Faz 2'de gerçek mesajlar gelecek, şimdilik placeholder.
 * flex-1 ile sidebar ve member list arasındaki kalan alanı doldurur.
 *
 * i18n: "chat" namespace'ini kullanır.
 * t("welcomeChannel", { channel: "general" }) → "Welcome to #general!"
 * Bu, i18next'in interpolation özelliği — {{channel}} yerine "general" gelir.
 */

import { useTranslation } from "react-i18next";

function ChatArea() {
  const { t } = useTranslation("chat");

  // Faz 2'de bu değer dinamik olacak (seçili kanaldan gelecek)
  const channelName = "general";

  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* ─── Channel Header ─── */}
      <div className="flex h-12 items-center border-b border-background-tertiary px-4 shadow-sm">
        <span className="mr-2 text-xl text-text-muted">#</span>
        <h3 className="font-semibold text-text-primary">{channelName}</h3>
        <span className="mx-3 h-6 w-px bg-background-tertiary" />
        <span className="text-sm text-text-muted">
          {t("channelStart", { channel: channelName })}
        </span>
      </div>

      {/* ─── Messages Area ─── */}
      <div className="flex flex-1 flex-col justify-end overflow-y-auto p-4">
        {/* Placeholder — Faz 2'de MessageList component'i gelecek */}
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-surface">
            <span className="text-3xl text-text-muted">#</span>
          </div>
          <h2 className="mb-1 text-2xl font-bold text-text-primary">
            {t("welcomeChannel", { channel: channelName })}
          </h2>
          <p className="text-text-muted">
            {t("channelStart", { channel: channelName })}
          </p>
        </div>
      </div>

      {/* ─── Message Input ─── */}
      <div className="px-4 pb-6">
        <div className="flex items-center rounded-lg bg-input px-4">
          {/* File upload button placeholder */}
          <button className="mr-2 text-text-muted hover:text-text-secondary">
            <svg
              className="h-5 w-5"
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
            className="flex-1 bg-transparent py-2.5 text-text-primary outline-none placeholder:text-text-muted"
            disabled
          />
        </div>
      </div>
    </div>
  );
}

export default ChatArea;
