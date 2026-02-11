/**
 * Sidebar — Sol panel: sunucu adı, kanal listesi, kullanıcı bilgisi.
 *
 * Discord'ta sol bar 3 bölümden oluşur:
 * 1. Üst: Sunucu adı (dropdown menü olacak)
 * 2. Orta: Kategoriler ve kanallar (scrollable)
 * 3. Alt: Kullanıcı bilgisi + ayar butonları
 *
 * i18n: "channels" ve "common" namespace'lerini kullanır.
 */

import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";

function Sidebar() {
  // ─── Hooks ───
  // İki namespace kullanıyoruz: "channels" (kanal isimleri) ve "common" (Online gibi genel kelimeler).
  // t("textChannels") → channels.json, t("online", { ns: "common" }) → common.json
  const { t } = useTranslation("channels");
  const { t: tCommon } = useTranslation("common");
  const { t: tAuth } = useTranslation("auth");
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="flex h-full w-[240px] flex-col bg-background-secondary">
      {/* ─── Server Header ─── */}
      <div className="flex h-12 items-center border-b border-background-tertiary px-4 shadow-sm">
        <h2 className="truncate text-base font-semibold text-text-primary">
          mqvi Server
        </h2>
      </div>

      {/* ─── Channel List ─── */}
      <div className="flex-1 overflow-y-auto px-2 pt-4">
        {/* Faz 2'de dinamik kanal listesi gelecek */}
        <div className="mb-1">
          <button className="flex w-full items-center gap-1 px-1 text-xs font-semibold uppercase text-text-muted hover:text-text-secondary">
            <svg
              className="h-3 w-3"
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
            {t("textChannels")}
          </button>
        </div>

        <button className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-channel-default hover:bg-surface-hover hover:text-channel-hover">
          <span className="text-lg leading-none">#</span>
          <span className="truncate text-sm">general</span>
        </button>

        <div className="mb-1 mt-4">
          <button className="flex w-full items-center gap-1 px-1 text-xs font-semibold uppercase text-text-muted hover:text-text-secondary">
            <svg
              className="h-3 w-3"
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
            {t("voiceChannels")}
          </button>
        </div>

        <button className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-channel-default hover:bg-surface-hover hover:text-channel-hover">
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15.536 8.464a5 5 0 010 7.072M12 6a7 7 0 010 14M8.464 8.464a5 5 0 000 7.072M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"
            />
          </svg>
          <span className="truncate text-sm">General Voice</span>
        </button>
      </div>

      {/* ─── User Bar (alt panel) ─── */}
      <div className="flex items-center gap-2 border-t border-background-tertiary bg-background-floating/50 px-2 py-2">
        {/* Avatar */}
        <div className="relative">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
            {user?.username?.charAt(0).toUpperCase() ?? "?"}
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background-floating bg-status-online" />
        </div>

        {/* Username */}
        <div className="flex-1 overflow-hidden">
          <p className="truncate text-sm font-medium text-text-primary">
            {user?.display_name ?? user?.username ?? "User"}
          </p>
          <p className="truncate text-xs text-text-muted">{tCommon("online")}</p>
        </div>

        {/* Logout button (geçici — Faz 6'da settings olacak) */}
        <button
          onClick={logout}
          title={tAuth("logout")}
          className="rounded p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default Sidebar;
