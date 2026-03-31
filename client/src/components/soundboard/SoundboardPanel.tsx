/**
 * SoundboardPanel — Grid of sound buttons, shown in the voice area.
 * Visible only when user is connected to a voice channel and panel is toggled open.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSoundboardStore } from "../../stores/soundboardStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useServerStore } from "../../stores/serverStore";
import { useMemberStore } from "../../stores/memberStore";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as soundboardApi from "../../api/soundboard";
import SoundUploadModal from "./SoundUploadModal";

function SoundboardPanel() {
  const { t } = useTranslation("soundboard");
  const sounds = useSoundboardStore((s) => s.sounds);
  const isLoading = useSoundboardStore((s) => s.isLoading);
  const playingSound = useSoundboardStore((s) => s.playingSound);
  const playSound = useSoundboardStore((s) => s.playSound);
  const fetchSounds = useSoundboardStore((s) => s.fetchSounds);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const serverId = useServerStore((s) => s.activeServerId);
  const members = useMemberStore((s) => s.members);
  const userId = useAuthStore((s) => s.user?.id);
  const confirm = useConfirmStore((s) => s.open);

  const [showUpload, setShowUpload] = useState(false);

  const currentMember = members.find((m) => m.id === userId);
  const perms = currentMember?.effective_permissions ?? 0;
  const canManage = hasPermission(perms, Permissions.ManageChannels);

  useEffect(() => {
    fetchSounds();
  }, [fetchSounds, serverId]);

  const handlePlay = (soundId: string) => {
    if (!currentVoiceChannelId) return;
    playSound(soundId);
  };

  const handleDelete = async (soundId: string, soundName: string) => {
    if (!serverId) return;
    const ok = await confirm({
      title: t("delete"),
      message: t("deleteConfirm", { name: soundName }),
      confirmLabel: t("delete"),
      danger: true,
    });
    if (ok) {
      await soundboardApi.deleteSound(serverId, soundId);
    }
  };

  if (isLoading) {
    return (
      <div className="sb-panel">
        <div className="sb-header">
          <span className="sb-title">{t("soundboard")}</span>
        </div>
        <div className="sb-loading">
          <div className="sb-spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="sb-panel">
      <div className="sb-header">
        <span className="sb-title">{t("soundboard")}</span>
        <span className="sb-count">{sounds.length}</span>
        {canManage && (
          <button className="sb-add-btn" onClick={() => setShowUpload(true)} title={t("addSound")}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1z" />
            </svg>
          </button>
        )}
      </div>

      {sounds.length === 0 ? (
        <div className="sb-empty">
          <p className="sb-empty-title">{t("noSounds")}</p>
          <p className="sb-empty-desc">{t("noSoundsDesc")}</p>
          {canManage && (
            <button className="sb-upload-btn" onClick={() => setShowUpload(true)}>
              {t("addSound")}
            </button>
          )}
        </div>
      ) : (
        <div className="sb-grid">
          {sounds.map((sound) => {
            const isPlaying = playingSound?.soundId === sound.id;
            return (
              <button
                key={sound.id}
                className={`sb-sound-btn${isPlaying ? " playing" : ""}${!currentVoiceChannelId ? " disabled" : ""}`}
                onClick={() => handlePlay(sound.id)}
                disabled={!currentVoiceChannelId}
                title={!currentVoiceChannelId ? t("mustBeInVoice") : sound.name}
              >
                <span className="sb-sound-emoji">{sound.emoji ?? "🔊"}</span>
                <span className="sb-sound-name">{sound.name}</span>
                {canManage && (
                  <button
                    className="sb-sound-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(sound.id, sound.name);
                    }}
                    title={t("delete")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z" />
                    </svg>
                  </button>
                )}
              </button>
            );
          })}
        </div>
      )}

      {showUpload && <SoundUploadModal onClose={() => setShowUpload(false)} />}
    </div>
  );
}

export default SoundboardPanel;
