/**
 * usePushToTalk — Push-to-talk (PTT) tuş dinleyicisi.
 *
 * Bu hook, document seviyesinde keydown/keyup event'lerini dinler ve
 * PTT modu aktifken belirlenen tuşa basılınca mikrofonu açar, bırakılınca kapatır.
 *
 * Güvenlik önlemleri:
 * 1. Focus guard: Kullanıcı bir <input> veya <textarea> içindeyken PTT çalışmaz.
 *    Aksi halde mesaj yazarken boşluk tuşu mikrofonu açardı.
 * 2. Repeat filtresi: Tuş basılı tutulduğunda tarayıcı keydown event'ini tekrarlar
 *    (e.repeat === true). Bu tekrarlar filtrelenir — sadece ilk basış işlenir.
 * 3. Mode guard: inputMode !== "push_to_talk" ise hook hiçbir şey yapmaz.
 * 4. Connection guard: Kullanıcı bir voice kanalında değilse event işlenmez.
 *
 * Neden document-level listener?
 * React'ın synthetic event sistemi component ağacına bağlıdır — sadece
 * o component focus'tayken çalışır. PTT tüm uygulama genelinde çalışmalı,
 * bu yüzden native document.addEventListener kullanılır.
 *
 * @param setMicEnabled — LiveKit localParticipant.setMicrophoneEnabled çağıran fonksiyon.
 *   VoiceStateManager'dan prop olarak gelir.
 */

import { useEffect, useRef } from "react";
import { useVoiceStore } from "../stores/voiceStore";

type UsePushToTalkParams = {
  /**
   * Mikrofonu aç/kapat fonksiyonu.
   * true → mic açık, false → mic kapalı.
   * Bu fonksiyon LiveKit participant'ı üzerinden çalışır.
   */
  setMicEnabled: (enabled: boolean) => void;
};

export function usePushToTalk({ setMicEnabled }: UsePushToTalkParams): void {
  const inputMode = useVoiceStore((s) => s.inputMode);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);

  // PTT tuşu şu anda basılı mı? Ref ile takip edilir —
  // state kullanılmaz çünkü re-render gereksizdir (side-effect only).
  const isPressedRef = useRef(false);

  useEffect(() => {
    // PTT modu aktif değilse veya voice kanalında değilsek listener ekleme
    if (inputMode !== "push_to_talk" || !currentVoiceChannelId) return;

    /**
     * isTextInput — Aktif element bir metin giriş alanı mı?
     *
     * PTT, kullanıcı bir text input'a yazarken devre dışı kalır.
     * Böylece Space tuşu mesaj yazarken mikrofonu açmaz.
     * contentEditable elementler de kontrol edilir (rich text editor).
     */
    function isTextInput(el: Element | null): boolean {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    }

    function handleKeyDown(e: KeyboardEvent) {
      // Tekrarlayan event'leri filtrele — tuş basılı tutulurken
      // tarayıcı keydown'u tekrar tekrar gönderir
      if (e.repeat) return;

      // PTT tuşu değilse işleme
      if (e.code !== pttKey) return;

      // Text input focus'taysa PTT çalışmasın
      if (isTextInput(document.activeElement)) return;

      // Zaten basılıysa tekrar açma (güvenlik)
      if (isPressedRef.current) return;

      isPressedRef.current = true;
      setMicEnabled(true);
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.code !== pttKey) return;

      // Tuş bırakıldığında text input kontrolü gerekmez —
      // basış zaten keydown'da engellendiyse isPressedRef false kalır
      if (!isPressedRef.current) return;

      isPressedRef.current = false;
      setMicEnabled(false);
    }

    // Sayfa focus kaybederse (alt-tab vb.) tuşu "bırak" olarak işle —
    // aksi halde kullanıcı başka pencereye geçtiğinde mic açık kalır
    function handleBlur() {
      if (isPressedRef.current) {
        isPressedRef.current = false;
        setMicEnabled(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);

      // Cleanup'ta mic'i kapat (PTT modundan çıkarken)
      if (isPressedRef.current) {
        isPressedRef.current = false;
        setMicEnabled(false);
      }
    };
  }, [inputMode, pttKey, currentVoiceChannelId, setMicEnabled]);
}
