/**
 * VoiceRoom — Ses odası GÖRSEL component'i.
 *
 * CSS class'ları: .voice-room, .voice-room-loading
 *
 * Layout stratejisi (Discord referans):
 * - Screen share yokken: Katılımcılar flex-1 grid olarak merkeze yayılır
 * - Screen share aktifken: Ekran paylaşımı flex-1 ile alanı kaplar,
 *   katılımcılar altta kompakt strip olarak gösterilir (shrink-0)
 *
 * LiveKit bağlantısı VoiceProvider tarafından AppLayout seviyesinde yönetilir.
 * Bu component sadece görsel render yapar. LiveKit context'i (RoomContext)
 * VoiceProvider'dan gelir — bu component mount/unmount olabilir,
 * ses bağlantısı etkilenmez.
 *
 * Component hiyerarşisi:
 * VoiceProvider (AppLayout seviyesinde — persistent)
 * └── LiveKitRoom (her zaman mount, connect prop ile kontrol)
 *     ├── RoomAudioRenderer (ses çalmaya devam eder)
 *     ├── VoiceStateManager (store sync devam eder)
 *     └── ... children (SplitPaneContainer → PanelView → VoiceRoom)
 *
 * VoiceRoom (PanelView içinde — tab değişince mount/unmount olabilir)
 * ├── VoiceConnectionStatus
 * ├── ScreenShareView
 * └── VoiceParticipantGrid
 */

import { useVoiceStore } from "../../stores/voiceStore";
import { useTranslation } from "react-i18next";
import VoiceParticipantGrid from "./VoiceParticipantGrid";
import VoiceConnectionStatus from "./VoiceConnectionStatus";
import ScreenShareView from "./ScreenShareView";

function VoiceRoom() {
  const { t } = useTranslation("voice");
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);

  // Token veya URL yoksa bağlanılamaz — loading göster
  if (!livekitUrl || !livekitToken) {
    return (
      <div className="voice-room-loading">
        <p>{t("connectingToVoice")}</p>
      </div>
    );
  }

  // LiveKit context VoiceProvider'dan gelir — burada sadece visual render.
  // Bu component unmount olsa bile ses bağlantısı korunur.
  return (
    <div className="voice-room">
      <VoiceConnectionStatus />
      <ScreenShareView />
      <VoiceParticipantGrid />
    </div>
  );
}

export default VoiceRoom;
