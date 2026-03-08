/** VoiceSettings — Voice & Audio settings tab. All settings persisted via voiceStore + localStorage. */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import type { InputMode } from "../../stores/voiceStore";


/** Simplified MediaDeviceInfo for select options. */
type DeviceOption = {
  deviceId: string;
  label: string;
};

/** Convert KeyboardEvent.code to a human-readable key name. */
function formatKeyCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);

  const mapping: Record<string, string> = {
    Space: "Space",
    ControlLeft: "Left Ctrl",
    ControlRight: "Right Ctrl",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    AltLeft: "Left Alt",
    AltRight: "Right Alt",
    Tab: "Tab",
    CapsLock: "Caps Lock",
    Backquote: "`",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Minus: "-",
    Equal: "=",
  };

  return mapping[code] ?? code;
}

/** Inline gradient for slider filled portion (Chrome lacks ::-moz-range-progress). */
function sliderTrackStyle(value: number, max: number): React.CSSProperties {
  const pct = (value / max) * 100;
  return {
    background: `linear-gradient(to right, var(--primary) ${pct}%, var(--bg-5) ${pct}%)`,
  };
}

function VoiceSettings() {
  const { t } = useTranslation("settings");

  // ─── Store state ───
  const inputMode = useVoiceStore((s) => s.inputMode);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const inputDevice = useVoiceStore((s) => s.inputDevice);
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const soundsEnabled = useVoiceStore((s) => s.soundsEnabled);
  const noiseReduction = useVoiceStore((s) => s.noiseReduction);

  const setInputMode = useVoiceStore((s) => s.setInputMode);
  const setPTTKey = useVoiceStore((s) => s.setPTTKey);
  const setMicSensitivity = useVoiceStore((s) => s.setMicSensitivity);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const setMasterVolume = useVoiceStore((s) => s.setMasterVolume);
  const setSoundsEnabled = useVoiceStore((s) => s.setSoundsEnabled);
  const setNoiseReduction = useVoiceStore((s) => s.setNoiseReduction);


  // ─── Local state ───
  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<DeviceOption[]>([]);
  const [isListeningKey, setIsListeningKey] = useState(false);

  // ─── Device enumeration ───
  useEffect(() => {
    async function loadDevices() {
      try {
        // Request mic permission first — labels are empty without it
        await navigator.mediaDevices.getUserMedia({ audio: true })
          .then((stream) => {
            // Close stream immediately after getting permission
            stream.getTracks().forEach((t) => t.stop());
          })
          .catch(() => {});

        const devices = await navigator.mediaDevices.enumerateDevices();

        const inputs: DeviceOption[] = devices
          .filter((d) => d.kind === "audioinput")
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `${t("inputDevice")} ${i + 1}`,
          }));

        const outputs: DeviceOption[] = devices
          .filter((d) => d.kind === "audiooutput")
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `${t("outputDevice")} ${i + 1}`,
          }));

        setAudioInputs(inputs);
        setAudioOutputs(outputs);
      } catch {}
    }

    loadDevices();
  }, [t]);

  // ─── PTT Key Binding ───
  useEffect(() => {
    if (!isListeningKey) return;

    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      // Cancel with Escape
      if (e.code === "Escape") {
        setIsListeningKey(false);
        return;
      }

      setPTTKey(e.code);
      setIsListeningKey(false);
    }

    document.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isListeningKey, setPTTKey]);

  const handleInputModeChange = useCallback(
    (mode: InputMode) => {
      setInputMode(mode);
    },
    [setInputMode]
  );

  return (
    <div className="voice-settings">
      <h2 className="settings-section-title">{t("voiceSettings")}</h2>

      {/* ─── Input Mode ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("voiceInputMode")}</div>
        <div className="vs-radio-group">
          <button
            className={`vs-radio${inputMode === "voice_activity" ? " active" : ""}`}
            onClick={() => handleInputModeChange("voice_activity")}
          >
            <div className="vs-radio-dot" />
            <div>
              <div className="vs-radio-title">{t("voiceActivity")}</div>
              <div className="vs-desc">{t("voiceActivityDesc")}</div>
            </div>
          </button>
          <button
            className={`vs-radio${inputMode === "push_to_talk" ? " active" : ""}`}
            onClick={() => handleInputModeChange("push_to_talk")}
          >
            <div className="vs-radio-dot" />
            <div>
              <div className="vs-radio-title">{t("pushToTalk")}</div>
              <div className="vs-desc">{t("pushToTalkDesc")}</div>
            </div>
          </button>
        </div>
      </div>

      {/* ─── PTT Key (only in PTT mode) ─── */}
      {inputMode === "push_to_talk" && (
        <div className="vs-section">
          <div className="vs-label">{t("pttKey")}</div>
          <button
            className={`vs-keybind${isListeningKey ? " listening" : ""}`}
            onClick={() => setIsListeningKey(true)}
          >
            {isListeningKey ? t("pttListening") : formatKeyCode(pttKey)}
          </button>
          <div className="vs-desc">{t("pttKeyHint")}</div>
        </div>
      )}

      {/* ─── Mic Sensitivity (voice activity mode only) ─── */}
      {inputMode === "voice_activity" && (
        <div className="vs-section">
          <div className="vs-label">{t("micSensitivity")}</div>
          <div className="vs-slider-row">
            <input
              type="range"
              min={0}
              max={100}
              value={micSensitivity}
              onChange={(e) => setMicSensitivity(Number(e.target.value))}
              className="vs-range"
              style={sliderTrackStyle(micSensitivity, 100)}
            />
            <span className="vs-slider-value">{micSensitivity}%</span>
          </div>
        </div>
      )}

      {/* ─── Input Device ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("inputDevice")}</div>
        <select
          className="vs-select"
          value={inputDevice}
          onChange={(e) => setInputDevice(e.target.value)}
        >
          <option value="">{t("defaultDevice")}</option>
          {audioInputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {/* ─── Output Device ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("outputDevice")}</div>
        <select
          className="vs-select"
          value={outputDevice}
          onChange={(e) => setOutputDevice(e.target.value)}
        >
          <option value="">{t("defaultDevice")}</option>
          {audioOutputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {/* ─── Master Volume ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("masterVolume")}</div>
        <div className="vs-slider-row">
          <input
            type="range"
            min={0}
            max={100}
            value={masterVolume}
            onChange={(e) => setMasterVolume(Number(e.target.value))}
            className="vs-range"
            style={sliderTrackStyle(masterVolume, 100)}
          />
          <span className="vs-slider-value">{masterVolume}%</span>
        </div>
      </div>

      {/* ─── Noise Reduction ─── */}
      <div className="vs-section">
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("noiseReduction")}</div>
            <div className="vs-desc">{t("noiseReductionDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={noiseReduction}
              onChange={(e) => setNoiseReduction(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>

      {/* ─── Join/Leave Sounds ─── */}
      <div className="vs-section">
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("joinLeaveSounds")}</div>
            <div className="vs-desc">{t("joinLeaveSoundsDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={soundsEnabled}
              onChange={(e) => setSoundsEnabled(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>

      {/* Screen Share Audio toggle moved to ScreenPicker modal */}
    </div>
  );
}

export default VoiceSettings;
