/**
 * ServerVoicePopup — Discord-style hover preview of a server's active voice
 * channels. Lists each channel with active participants stacked vertically,
 * showing only the participants' avatars. Renders null when the server has no
 * one in voice. Positioned via portal next to the hovered server row.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVoiceStore } from "../../stores/voiceStore";
import Avatar from "../shared/Avatar";
import type { VoiceState } from "../../types";

type ServerVoicePopupProps = {
  serverId: string;
  anchorTop: number;
  anchorLeft: number;
};

function ServerVoicePopup({ serverId, anchorTop, anchorLeft }: ServerVoicePopupProps) {
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const popupRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchorTop, left: anchorLeft });

  // Group this server's voice participants by channel.
  const byChannel = new Map<string, VoiceState[]>();
  for (const list of Object.values(voiceStates)) {
    for (const st of list) {
      if (st.server_id !== serverId) continue;
      const arr = byChannel.get(st.channel_id) ?? [];
      arr.push(st);
      byChannel.set(st.channel_id, arr);
    }
  }
  const channels = Array.from(byChannel, ([id, participants]) => ({
    id,
    name: participants[0]?.channel_name ?? "",
    participants,
  }));

  // Keep the popup inside the viewport vertically once its height is known.
  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let top = anchorTop;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - rect.height - 8);
    }
    setPos({ top, left: anchorLeft });
  }, [anchorTop, anchorLeft, channels.length]);

  if (channels.length === 0) return null;

  return createPortal(
    <div ref={popupRef} className="server-voice-popup" style={{ top: pos.top, left: pos.left }}>
      {channels.map((ch) => (
        <div key={ch.id} className="svp-channel">
          <div className="svp-channel-name">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.536 8.464a5 5 0 010 7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
              />
            </svg>
            <span>{ch.name}</span>
          </div>
          <div className="svp-avatars">
            {ch.participants.map((p) => (
              <div key={p.user_id} className="svp-avatar" title={p.display_name}>
                <Avatar name={p.display_name} avatarUrl={p.avatar_url} size={28} isCircle />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>,
    document.body
  );
}

export default ServerVoicePopup;
