/**
 * Sidebar — Sol panel: sunucu adı, kanal listesi, kullanıcı bilgisi.
 *
 * Discord referans spacing'leri:
 * - Server header: h-header(48px), px-4, hover ile dropdown olacak
 * - Kategori başlıkları: 18px üst margin, uppercase, küçük font
 * - Kanal item'ları: 32px yükseklik, 8px sol padding, hover bg
 * - User bar: 52px yükseklik, 8px padding, koyu arka plan
 */

import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";

function Sidebar() {
  const { t } = useTranslation("channels");
  const { t: tCommon } = useTranslation("common");
  const { t: tAuth } = useTranslation("auth");
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="flex h-full w-sidebar flex-col bg-background-secondary">
      {/* ─── Server Header ─── */}
      <div className="flex h-header shrink-0 cursor-pointer items-center border-b border-background-tertiary px-4 transition-colors hover:bg-surface-hover">
        <h2 className="truncate text-[15px] font-semibold text-text-primary">
          mqvi Server
        </h2>
      </div>

      {/* ─── Channel List ─── */}
      <nav className="flex-1 overflow-y-auto pb-4 pt-3">
        {/* ── Text Channels Category ── */}
        <div className="px-4 pb-1 pt-4">
          <button className="flex w-full items-center gap-1 text-[11px] font-bold uppercase tracking-[0.02em] text-text-muted transition-colors hover:text-text-secondary">
            <svg
              className="h-3 w-3 shrink-0"
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

        {/* Channel item */}
        <div className="mx-2 mt-0.5">
          <button className="flex h-[34px] w-full items-center gap-2 rounded-md px-2 text-channel-default transition-colors hover:bg-surface-hover hover:text-channel-hover">
            <span className="shrink-0 text-xl leading-none opacity-70">#</span>
            <span className="truncate text-[15px] font-medium">general</span>
          </button>
        </div>

        {/* ── Voice Channels Category ── */}
        <div className="px-4 pb-1 pt-5">
          <button className="flex w-full items-center gap-1 text-[11px] font-bold uppercase tracking-[0.02em] text-text-muted transition-colors hover:text-text-secondary">
            <svg
              className="h-3 w-3 shrink-0"
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

        {/* Voice channel item */}
        <div className="mx-2 mt-0.5">
          <button className="flex h-[34px] w-full items-center gap-2 rounded-md px-2 text-channel-default transition-colors hover:bg-surface-hover hover:text-channel-hover">
            <svg
              className="h-5 w-5 shrink-0 opacity-70"
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
            <span className="truncate text-[15px] font-medium">General Voice</span>
          </button>
        </div>
      </nav>

      {/* ─── User Bar ─── */}
      <div className="flex min-h-user-bar items-center gap-3 bg-background-floating/60 px-3 py-1.5">
        {/* Avatar */}
        <div className="relative shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
            {user?.username?.charAt(0).toUpperCase() ?? "?"}
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-[2.5px] border-background-floating bg-status-online" />
        </div>

        {/* Username + status */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-5 text-text-primary">
            {user?.display_name ?? user?.username ?? "User"}
          </p>
          <p className="truncate text-[11px] leading-4 text-text-muted">
            {tCommon("online")}
          </p>
        </div>

        {/* Settings/Logout buttons */}
        <div className="flex shrink-0 items-center">
          <button
            onClick={logout}
            title={tAuth("logout")}
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <svg
              className="h-[18px] w-[18px]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default Sidebar;
