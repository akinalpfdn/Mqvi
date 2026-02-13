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
import { useSettingsStore } from "../../stores/settingsStore";
import { useServerStore } from "../../stores/serverStore";
import ChannelList from "../channels/ChannelList";
import VoiceControls from "../voice/VoiceControls";

type SidebarProps = {
  onJoinVoice: (channelId: string) => Promise<void>;
  onLeaveVoice: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
};

function Sidebar({ onJoinVoice, onLeaveVoice, onToggleMute, onToggleDeafen, onToggleScreenShare }: SidebarProps) {
  const { t: tCommon } = useTranslation("common");
  const { t: tAuth } = useTranslation("auth");
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const server = useServerStore((s) => s.server);

  return (
    <div className="flex h-full w-sidebar flex-col bg-background-secondary">
      {/* ─── Server Header ─── */}
      <div className="flex h-header shrink-0 cursor-pointer items-center border-b border-background-tertiary px-4 transition-colors hover:bg-surface-hover">
        <h2 className="truncate text-[15px] font-semibold text-text-primary">
          {server?.name ?? "mqvi Server"}
        </h2>
      </div>

      {/* ─── Channel List (dinamik) ─── */}
      <ChannelList onJoinVoice={onJoinVoice} />

      {/* ─── Voice Controls (ses kanalına bağlıyken görünür) ─── */}
      <VoiceControls
        onToggleMute={onToggleMute}
        onToggleDeafen={onToggleDeafen}
        onToggleScreenShare={onToggleScreenShare}
        onDisconnect={onLeaveVoice}
      />

      {/* ─── User Bar ─── */}
      <div className="flex min-h-user-bar items-center gap-3 bg-background-floating/60 px-3 py-1.5">
        {/* Avatar — avatar_url varsa resim, yoksa ilk harf */}
        <div className="relative shrink-0">
          {user?.avatar_url ? (
            <img
              src={user.avatar_url}
              alt={user.display_name ?? user.username}
              className="h-9 w-9 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
              {user?.username?.charAt(0).toUpperCase() ?? "?"}
            </div>
          )}
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
          {/* Gear icon — Settings modal'ı açar */}
          <button
            onClick={() => openSettings()}
            title={tCommon("settings")}
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
                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>

          {/* Logout butonu */}
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
