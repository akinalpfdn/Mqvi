/**
 * VoiceConnectionStatus — LiveKit bağlantı durumu göstergesi.
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

  // Duruma göre mesaj ve renk belirle
  const statusConfig: Record<string, { message: string; color: string }> = {
    [ConnectionState.Connecting]: {
      message: t("connectingToVoice"),
      color: "text-yellow-400",
    },
    [ConnectionState.Reconnecting]: {
      message: t("reconnectingToVoice"),
      color: "text-yellow-400",
    },
    [ConnectionState.Disconnected]: {
      message: t("voiceDisconnected"),
      color: "text-danger",
    },
  };

  const config = statusConfig[connectionState] ?? {
    message: connectionState,
    color: "text-text-muted",
  };

  return (
    <div className="flex items-center justify-center gap-2 bg-background-secondary/80 px-4 py-2">
      {/* Animasyonlu dot — connecting/reconnecting durumunda pulse */}
      <span
        className={`h-2 w-2 rounded-full ${
          connectionState === ConnectionState.Disconnected
            ? "bg-danger"
            : "animate-pulse bg-yellow-400"
        }`}
      />
      <span className={`text-xs font-medium ${config.color}`}>
        {config.message}
      </span>
    </div>
  );
}

export default VoiceConnectionStatus;
