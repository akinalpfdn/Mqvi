/**
 * ChannelItem — Sidebar'daki tek bir kanal item'ı.
 *
 * Kanalın tipine göre farklı icon gösterir:
 * - text: # (hash) sembolü
 * - voice: hoparlör SVG icon'u + altında katılımcı listesi
 *
 * Active (seçili) ve hover state'leri var.
 *
 * Voice kanalları için voiceParticipants prop'u ile o kanalda bulunan
 * kullanıcıların küçük avatar + isim listesi gösterilir (Discord tarzı).
 */

import type { Channel, VoiceState } from "../../types";
import VoiceChannelUser from "../voice/VoiceChannelUser";

type ChannelItemProps = {
  channel: Channel;
  isActive: boolean;
  /** Voice kanallardaki katılımcılar (text kanallar için boş array) */
  voiceParticipants: VoiceState[];
  onClick: () => void;
};

function ChannelItem({ channel, isActive, voiceParticipants, onClick }: ChannelItemProps) {
  return (
    <div className="mx-2 mt-0.5">
      <button
        onClick={onClick}
        className={`flex h-[34px] w-full items-center gap-2 rounded-md px-2 transition-colors ${
          isActive
            ? "bg-surface-hover text-text-primary"
            : "text-channel-default hover:bg-surface-hover hover:text-channel-hover"
        }`}
      >
        {channel.type === "text" ? (
          <span className="shrink-0 text-xl leading-none opacity-70">#</span>
        ) : (
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
        )}
        <span className="truncate text-[15px] font-medium">{channel.name}</span>
      </button>

      {/* Voice kanal katılımcıları — kanal altında küçük kullanıcı listesi */}
      {channel.type === "voice" && voiceParticipants.length > 0 && (
        <div className="pb-1">
          {voiceParticipants.map((vs) => (
            <VoiceChannelUser key={vs.user_id} voiceState={vs} />
          ))}
        </div>
      )}
    </div>
  );
}

export default ChannelItem;
