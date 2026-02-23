/**
 * VoiceConnectionStatus — LiveKit bağlantı durumu göstergesi.
 *
 * CSS class'ları: .voice-connection-status, .voice-connection-dot,
 * .voice-connection-dot.connecting, .voice-connection-dot.error,
 * .voice-connection-text, .voice-connection-text.warning,
 * .voice-connection-text.error, .voice-connection-text.muted
 *
 * LiveKitRoom içinde render edilir. useConnectionState() hook'u ile
 * bağlantı durumunu okur ve kullanıcıya gösterir.
 *
 * Durumlar:
 * - Connected: Gösterge gizli (normal durum)
 * - Connecting: "Bağlanılıyor..." mesajı
 * - Reconnecting: "Yeniden bağlanılıyor..." mesajı
 * - Disconnected: "Bağlantı koptu" mesajı
 *
 * Bu component olmasaydı:
 * - LiveKit bağlantı hatası sessizce yutulurdu
 * - Kullanıcı bağlantı durumunu bilmezdi
 * - "Ses neden gitmiyor?" sorusunun cevabı gizli kalırdı
 */

import { useConnectionState } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { useTranslation } from "react-i18next";

function VoiceConnectionStatus() {
  const { t } = useTranslation("voice");

  // useConnectionState: LiveKit React SDK hook'u.
  // LiveKitRoom context'inden bağlantı durumunu okur.
  const connectionState = useConnectionState();

  // Bağlıysa gösterge gerekmez
  if (connectionState === ConnectionState.Connected) {
    return null;
  }

  // Duruma göre mesaj, dot class ve text class belirle
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
