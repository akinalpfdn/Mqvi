/**
 * VoiceSettings — Settings modal'daki "Voice & Audio" tab'ı.
 *
 * CSS class'ları: .voice-settings, .vs-section, .vs-label,
 * .vs-desc, .vs-radio-group, .vs-radio, .vs-radio.active,
 * .vs-slider-row, .vs-select, .vs-keybind, .vs-keybind.listening,
 * .vs-toggle-row
 *
 * Ayarlar:
 * 1. Input Mode: Voice Activity / Push to Talk toggle
 * 2. PTT Key: Tuş atama (tıkla → "Press a key..." → keydown ile yakala)
 * 3. Mic Sensitivity: Slider (0-100)
 * 4. Input Device: navigator.mediaDevices.enumerateDevices() ile select
 * 5. Output Device: Select
 * 6. Master Volume: Slider (0-100)
 * 7. Join/Leave Sounds: Toggle switch
 *
 * Tüm ayarlar voiceStore üzerinden yönetilir ve localStorage'da persist edilir.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import type { InputMode } from "../../stores/voiceStore";


/**
 * MediaDeviceInfo'nun basitleştirilmiş hali.
 * enumerateDevices() sonucu bu formata dönüştürülür.
 */
type DeviceOption = {
  deviceId: string;
  label: string;
};

/**
 * Keyboard code → kullanıcı dostu isim dönüşümü.
 *
 * KeyboardEvent.code fiziksel tuşu temsil eder ("Space", "KeyV", "ControlLeft" vb.)
 * Kullanıcıya göstermek için daha okunabilir isimlere çevrilir.
 */
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

/**
 * sliderTrackStyle — Slider'ın dolu kısmını amber renkle boyar.
 *
 * CSS'te `::-webkit-slider-runnable-track` ile gradient background uygulanır.
 * value/max oranına göre sol kısım amber, sağ kısım koyu arka plan olur.
 *
 * Neden inline style?
 * CSS'te slider value'suna göre track rengi değiştiremezsin — ::-webkit-slider-runnable-track
 * sadece statik background kabul eder. JavaScript ile value'ya göre linear-gradient
 * hesaplanıp inline olarak atanır.
 *
 * Firefox bunu native destekler (::-moz-range-progress), Chrome desteklemez.
 */
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

  const setInputMode = useVoiceStore((s) => s.setInputMode);
  const setPTTKey = useVoiceStore((s) => s.setPTTKey);
  const setMicSensitivity = useVoiceStore((s) => s.setMicSensitivity);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const setMasterVolume = useVoiceStore((s) => s.setMasterVolume);
  const setSoundsEnabled = useVoiceStore((s) => s.setSoundsEnabled);


  // ─── Local state ───
  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<DeviceOption[]>([]);
  const [isListeningKey, setIsListeningKey] = useState(false);

  // ─── Device enumeration ───
  // navigator.mediaDevices.enumerateDevices() tüm medya cihazlarını listeler.
  // Label bilgisi için mic erişim izni gerekir — izin verilmemişse
  // label boş string olur, biz "Microphone 1" gibi fallback gösteririz.
  useEffect(() => {
    async function loadDevices() {
      try {
        // Önce mic izni iste — izin verilmeden label bilgisi gelmez
        await navigator.mediaDevices.getUserMedia({ audio: true })
          .then((stream) => {
            // İzin alındıktan sonra stream'i hemen kapat (bant genişliği)
            stream.getTracks().forEach((t) => t.stop());
          })
          .catch(() => {
            // İzin reddedildi — label'sız devam et
          });

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
      } catch {
        // enumerateDevices desteklenmiyor veya hata oluştu
      }
    }

    loadDevices();
  }, [t]);

  // ─── PTT Key Binding ───
  // "Press a key..." modunda: bir sonraki keydown'u yakala ve PTT tuşu olarak ayarla.
  useEffect(() => {
    if (!isListeningKey) return;

    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      // Escape ile iptal
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

      {/* ─── PTT Key (sadece PTT modunda göster) ─── */}
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

      {/* ─── Mic Sensitivity (sadece voice activity modunda anlamlı) ─── */}
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

      {/* Screen Share Audio toggle — ScreenPicker modalına taşındı.
          Ekran paylaşımı başlarken picker'da gösterilir, daha keşfedilebilir. */}
    </div>
  );
}

export default VoiceSettings;
