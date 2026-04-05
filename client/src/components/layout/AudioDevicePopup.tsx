/**
 * AudioDevicePopup — Discord-style device picker with side-expanding submenu.
 *
 * Main panel shows: device header (with active device name + chevron),
 * volume slider, and Voice Settings link.
 * Chevron expands a submenu to the right with the full device list.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useSettingsStore } from "../../stores/settingsStore";

type DeviceOption = {
  deviceId: string;
  label: string;
};

type AudioDevicePopupProps = {
  kind: "input" | "output";
  anchorEl: HTMLElement;
  onClose: () => void;
};

function AudioDevicePopup({ kind, anchorEl, onClose }: AudioDevicePopupProps) {
  const { t } = useTranslation("settings");
  const { t: tv } = useTranslation("voice");
  const popupRef = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [showDeviceList, setShowDeviceList] = useState(false);

  const inputDevice = useVoiceStore((s) => s.inputDevice);
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const setMasterVolume = useVoiceStore((s) => s.setMasterVolume);
  const setInputVolume = useVoiceStore((s) => s.setInputVolume);
  const setMicSensitivity = useVoiceStore((s) => s.setMicSensitivity);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const selectedDevice = kind === "input" ? inputDevice : outputDevice;
  const setDevice = kind === "input" ? setInputDevice : setOutputDevice;

  // Load device list
  useEffect(() => {
    async function load() {
      try {
        if (kind === "input") {
          await navigator.mediaDevices.getUserMedia({ audio: true })
            .then((stream) => stream.getTracks().forEach((t) => t.stop()))
            .catch(() => {});
        }

        const all = await navigator.mediaDevices.enumerateDevices();
        const filtered = all
          .filter((d) => d.kind === (kind === "input" ? "audioinput" : "audiooutput"))
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `${kind === "input" ? t("inputDevice") : t("outputDevice")} ${i + 1}`,
          }));
        setDevices(filtered);
      } catch {}
    }
    load();
  }, [kind, t]);

  // Find active device label
  const activeDevice = devices.find((d) => d.deviceId === selectedDevice)
    ?? devices.find((d) => d.deviceId === "default" || d.deviceId === "")
    ?? devices[0];
  const activeLabel = activeDevice?.label ?? (kind === "input" ? t("inputDevice") : t("outputDevice"));

  // Position popup above anchor
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    setPos({ top: rect.top - 6, left: rect.left });
  }, [anchorEl]);

  // Clamp to viewport after render
  useEffect(() => {
    if (!popupRef.current || !pos) return;
    const menu = popupRef.current;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = pos.left;
    let y = pos.top;

    // Transform is translateY(-100%) so effective top = y - height
    const effectiveTop = y - rect.height;
    if (effectiveTop < 8) {
      y = rect.height + 8;
    }
    if (x + rect.width > vw - 8) {
      x = vw - rect.width - 8;
    }

    if (x !== pos.left || y !== pos.top) {
      setPos({ top: y, left: x });
    }
  }, [pos]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const volumeValue = kind === "input" ? inputVolume : masterVolume;
  const volumeMax = kind === "input" ? 200 : 100;

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      if (kind === "input") {
        setInputVolume(val);
      } else {
        setMasterVolume(val);
      }
    },
    [kind, setMasterVolume, setInputVolume]
  );

  const handleSensitivityChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setMicSensitivity(Number(e.target.value));
    },
    [setMicSensitivity]
  );

  const handleDeviceSelect = useCallback(
    (deviceId: string) => {
      setDevice(deviceId);
      setShowDeviceList(false);
    },
    [setDevice]
  );

  const handleOpenSettings = useCallback(() => {
    openSettings("voice");
    onClose();
  }, [openSettings, onClose]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={popupRef}
      className="adp-popup"
      style={{ top: pos.top, left: pos.left, transform: "translateY(-100%)" }}
    >
      {/* Device header — click to expand submenu */}
      <button
        className="adp-device-header"
        onClick={() => setShowDeviceList(!showDeviceList)}
      >
        <div className="adp-device-header-text">
          <span className="adp-device-header-title">
            {kind === "input" ? t("inputDevice") : t("outputDevice")}
          </span>
          <span className="adp-device-header-active">{activeLabel}</span>
        </div>
        <svg
          className={`adp-device-header-chevron${showDeviceList ? " open" : ""}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>

      {/* Side-expanding device submenu */}
      {showDeviceList && (
        <div className="adp-submenu">
          {devices.map((d) => {
            const isDefault = d.deviceId === "default" || d.deviceId === "";
            const isSelected = selectedDevice
              ? selectedDevice === d.deviceId
              : isDefault;
            return (
              <button
                key={d.deviceId}
                className={`adp-submenu-item${isSelected ? " selected" : ""}`}
                onClick={() => handleDeviceSelect(d.deviceId)}
              >
                <span className="adp-submenu-label">{d.label}</span>
                {isSelected && (
                  <div className="adp-submenu-check" />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="adp-divider" />

      {/* Volume slider */}
      <div className="adp-section">
        <div className="adp-label">
          {kind === "input" ? tv("micVolume") : t("masterVolume")}
        </div>
        <div className="adp-slider-row">
          <input
            type="range"
            min={0}
            max={volumeMax}
            value={volumeValue}
            onChange={handleVolumeChange}
            className="adp-range"
            style={{
              background: `linear-gradient(to right, var(--primary) ${(volumeValue / volumeMax) * 100}%, var(--bg-5) ${(volumeValue / volumeMax) * 100}%)`,
            }}
          />
          <span className="adp-vol-value">{volumeValue}%</span>
        </div>
      </div>

      {/* Mic sensitivity slider (input only) */}
      {kind === "input" && (
        <div className="adp-section">
          <div className="adp-label">{t("micSensitivity")}</div>
          <div className="adp-slider-row">
            <input
              type="range"
              min={0}
              max={100}
              value={micSensitivity}
              onChange={handleSensitivityChange}
              className="adp-range"
              style={{
                background: `linear-gradient(to right, var(--primary) ${micSensitivity}%, var(--bg-5) ${micSensitivity}%)`,
              }}
            />
            <span className="adp-vol-value">{micSensitivity}%</span>
          </div>
        </div>
      )}

      <div className="adp-divider" />

      {/* Voice Settings link */}
      <button className="adp-settings-link" onClick={handleOpenSettings}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.3-3.7a1.5 1.5 0 0 1 .3 1.7l-.9 1.5a1.5 1.5 0 0 1-1.6.7l-1.1-.2a7 7 0 0 1-1.2.7l-.3 1.1a1.5 1.5 0 0 1-1.4 1h-1.8a1.5 1.5 0 0 1-1.4-1l-.3-1.1a7 7 0 0 1-1.2-.7l-1.1.2a1.5 1.5 0 0 1-1.6-.7l-.9-1.5a1.5 1.5 0 0 1 .3-1.7l.8-.9V10a7 7 0 0 1 0-1.4l-.8-.9a1.5 1.5 0 0 1-.3-1.7l.9-1.5a1.5 1.5 0 0 1 1.6-.7l1.1.2a7 7 0 0 1 1.2-.7l.3-1.1a1.5 1.5 0 0 1 1.4-1h1.8a1.5 1.5 0 0 1 1.4 1l.3 1.1a7 7 0 0 1 1.2.7l1.1-.2a1.5 1.5 0 0 1 1.6.7l.9 1.5a1.5 1.5 0 0 1-.3 1.7l-.8.9a7 7 0 0 1 0 1.4l.8.9z" />
        </svg>
        {t("voiceSettings")}
      </button>
    </div>,
    document.body
  );
}

export default AudioDevicePopup;
