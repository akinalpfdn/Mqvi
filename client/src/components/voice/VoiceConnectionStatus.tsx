/** VoiceConnectionStatus — LiveKit connection state indicator. Hidden when connected. */

import { useConnectionState } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { useTranslation } from "react-i18next";

function VoiceConnectionStatus() {
  const { t } = useTranslation("voice");
  const connectionState = useConnectionState();

  if (connectionState === ConnectionState.Connected) {
    return null;
  }

  const statusConfig: Record<string, { message: string; dotClass: string; textClass: string }> = {
    [ConnectionState.Connecting]: {
      message: t("connectingToVoice"),
      dotClass: "voice-connection-dot connecting",
      textClass: "voice-connection-text warning",
    },
    [ConnectionState.Reconnecting]: {
      message: t("reconnectingToVoice"),
      dotClass: "voice-connection-dot connecting",
      textClass: "voice-connection-text warning",
    },
    [ConnectionState.Disconnected]: {
      message: t("voiceDisconnectedHint"),
      dotClass: "voice-connection-dot error",
      textClass: "voice-connection-text error",
    },
  };

  const config = statusConfig[connectionState] ?? {
    message: connectionState,
    dotClass: "voice-connection-dot",
    textClass: "voice-connection-text muted",
  };

  return (
    <div className="voice-connection-status">
      <span className={config.dotClass} />
      <span className={config.textClass}>{config.message}</span>
    </div>
  );
}

export default VoiceConnectionStatus;
