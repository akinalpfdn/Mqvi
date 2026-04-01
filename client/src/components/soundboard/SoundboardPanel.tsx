/**
 * SoundboardPanel — Compact grid of sound buttons with search, volume control.
 * Floating popup from UserBar voice controls.
 *
 * No reusable VolumeControl or SearchInput exists in the codebase — inline range/input used
 * consistently across VoiceSettings, VoiceUserContextMenu, ScreenShareContextMenu.
 */

import { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSoundboardStore } from "../../stores/soundboardStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useServerStore } from "../../stores/serverStore";
import { useMemberStore } from "../../stores/memberStore";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as soundboardApi from "../../api/soundboard";
import SoundUploadForm from "./SoundUploadForm";

function SoundboardPanel() {
  const { t } = useTranslation("soundboard");
  const sounds = useSoundboardStore((s) => s.sounds);
  const isLoading = useSoundboardStore((s) => s.isLoading);
  const playingSound = useSoundboardStore((s) => s.playingSound);
  const playSound = useSoundboardStore((s) => s.playSound);
  const fetchSounds = useSoundboardStore((s) => s.fetchSounds);
  const volume = useSoundboardStore((s) => s.volume);
  const muted = useSoundboardStore((s) => s.muted);
  const setVolume = useSoundboardStore((s) => s.setVolume);
  const toggleMuted = useSoundboardStore((s) => s.toggleMuted);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const serverId = useServerStore((s) => s.activeServerId);
  const members = useMemberStore((s) => s.members);
  const userId = useAuthStore((s) => s.user?.id);
  const confirm = useConfirmStore((s) => s.open);

  const [showUpload, setShowUpload] = useState(false);
  const [search, setSearch] = useState("");

  const currentMember = members.find((m) => m.id === userId);
  const perms = currentMember?.effective_permissions ?? 0;
  const canManage = hasPermission(perms, Permissions.ManageSoundboard);

  const filtered = useMemo(() => {
    if (!search.trim()) return sounds;
    const q = search.toLowerCase();
    return sounds.filter((s) => s.name.toLowerCase().includes(q));
  }, [sounds, search]);

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

  if (showUpload) {
    return (
      <div className="sb-panel">
        <SoundUploadForm onClose={() => setShowUpload(false)} />
      </div>
    );
  }

  return (
    <div className="sb-panel">
      {/* Header */}
      <div className="sb-header">
        <span className="sb-title">{t("soundboard")}</span>
        <span className="sb-count">{sounds.length}</span>
        {canManage && (
          <button className="sb-add-btn" onClick={() => setShowUpload(true)} title={t("addSound")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1z" />
            </svg>
          </button>
        )}
      </div>

      {/* Search */}
      {sounds.length > 3 && (
        <input
          type="text"
          className="sb-search"
          placeholder={t("search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {/* Volume control */}
      <div className="sb-volume-row">
        <button className="sb-vol-btn" onClick={toggleMuted} title={muted ? t("unmute") : t("mute")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            {muted ? (
              <path d="M3.63 3.63a.996.996 0 000 1.41L7.29 8.7 7 9H4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71v-4.17l4.18 4.18c-.49.37-1.02.68-1.6.91-.36.15-.58.53-.58.92 0 .72.73 1.18 1.39.91.8-.33 1.55-.77 2.22-1.31l1.34 1.34a.996.996 0 101.41-1.41L5.05 3.63c-.39-.39-1.02-.39-1.42 0zM19 12c0 .82-.15 1.61-.41 2.34l1.53 1.53c.56-1.17.88-2.48.88-3.87 0-3.83-2.4-7.11-5.78-8.4-.59-.23-1.22.23-1.22.86v.19c0 .38.25.71.61.85C17.18 6.54 19 9.06 19 12zm-8.71-6.29l-.17.17L12 7.76V6.41c0-.89-1.08-1.33-1.71-.7zM16.5 12A4.5 4.5 0 0014 7.97v1.79l2.48 2.48c.01-.08.02-.16.02-.24z" />
            ) : (
              <path d="M3 10v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71V6.41c0-.89-1.08-1.34-1.71-.71L7 9H4c-.55 0-1 .45-1 1zm13.5 2A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-3.02zM14 3.23v.06c0 .38.25.71.61.85C17.18 5.18 19 7.56 19 12s-1.82 6.82-4.39 7.86c-.36.14-.61.47-.61.85v.06c0 .63.63 1.08 1.22.85C18.6 20.11 21 16.38 21 12s-2.4-8.11-5.78-9.61c-.59-.23-1.22.22-1.22.84z" />
            )}
          </svg>
        </button>
        <input
          type="range"
          className="sb-vol-slider"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (muted && v > 0) toggleMuted();
            setVolume(v);
          }}
        />
        <span className="sb-vol-pct">{muted ? 0 : Math.round(volume * 100)}%</span>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="sb-loading"><div className="sb-spinner" /></div>
      ) : sounds.length === 0 ? (
        <div className="sb-empty">
          <p className="sb-empty-title">{t("noSounds")}</p>
          <p className="sb-empty-desc">{t("noSoundsDesc")}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="sb-empty">
          <p className="sb-empty-title">{t("noResults")}</p>
        </div>
      ) : (
        <div className="sb-grid">
          {filtered.map((sound) => {
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
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z" />
                    </svg>
                  </button>
                )}
              </button>
            );
          })}
        </div>
      )}

    </div>
  );
}

export default SoundboardPanel;
