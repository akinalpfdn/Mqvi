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

  return (
    <div className="flex h-full w-sidebar flex-col bg-background-secondary">
      {/* ─── Server Header ─── */}
      <div className="flex h-header shrink-0 cursor-pointer items-center border-b border-background-tertiary px-4 transition-colors hover:bg-surface-hover">
        <h2 className="truncate text-[15px] font-semibold text-text-primary">
          mqvi Server
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
