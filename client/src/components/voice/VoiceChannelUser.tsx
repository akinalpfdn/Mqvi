/**
 * VoiceChannelUser — Sidebar'da voice kanal altında küçük kullanıcı satırı.
 *
 * Bir ses kanalına bağlı olan her kullanıcı için gösterilir:
 * - Letter avatar (ilk harf)
 * - Username
 * - Mute / deafen / streaming icon'ları (duruma göre)
 *
 * Discord referans: Voice kanallarının altındaki küçük kullanıcı listesi.
 */

import type { VoiceState } from "../../types";

type VoiceChannelUserProps = {
  voiceState: VoiceState;
};

function VoiceChannelUser({ voiceState }: VoiceChannelUserProps) {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-8 pr-2">
      {/* Letter avatar */}
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">
        {voiceState.username.charAt(0).toUpperCase()}
      </div>

      {/* Username */}
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
        {voiceState.username}
      </span>

      {/* State icons */}
      <div className="flex shrink-0 items-center gap-0.5">
        {voiceState.is_muted && (
          <svg
            className="h-3.5 w-3.5 text-danger"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"
            />
          </svg>
        )}

        {voiceState.is_deafened && (
          <svg
            className="h-3.5 w-3.5 text-danger"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728A9 9 0 015.636 5.636"
            />
          </svg>
        )}

        {voiceState.is_streaming && (
          <svg
            className="h-3.5 w-3.5 text-brand"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        )}
      </div>
    </div>
  );
}

export default VoiceChannelUser;
