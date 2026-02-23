/**
 * i18n (internationalization) konfigürasyonu.
 *
 * i18next nedir?
 * Çok dilli uygulama geliştirmek için kullanılan framework.
 * Anahtar-değer çiftleriyle çevirileri yönetir:
 *   t("auth.login") → "Log In" (EN) veya "Giriş Yap" (TR)
 *
 * Namespace nedir?
 * Çevirileri mantıksal gruplara ayırmak için kullanılır:
 *   - common: genel kelimeler (Save, Cancel, Error...)
 *   - auth: giriş/kayıt sayfaları
 *   - channels: kanal ile ilgili
 *   - chat: mesajlaşma ile ilgili
 *   - settings: ayarlar sayfası
 *
 * Yeni bir string eklerken:
 * 1. İlgili namespace JSON'una EN + TR çevirisini ekle
 * 2. Component'te: const { t } = useTranslation("namespace");
 * 3. JSX'te: {t("key")}
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

// ─── EN Translation Files ───
import enCommon from "./locales/en/common.json";
import enAuth from "./locales/en/auth.json";
import enChannels from "./locales/en/channels.json";
import enChat from "./locales/en/chat.json";
import enSettings from "./locales/en/settings.json";
import enVoice from "./locales/en/voice.json";
import enLanding from "./locales/en/landing.json";

// ─── TR Translation Files ───
import trCommon from "./locales/tr/common.json";
import trAuth from "./locales/tr/auth.json";
import trChannels from "./locales/tr/channels.json";
import trChat from "./locales/tr/chat.json";
import trSettings from "./locales/tr/settings.json";
import trVoice from "./locales/tr/voice.json";
import trLanding from "./locales/tr/landing.json";

/** Desteklenen diller */
export const SUPPORTED_LANGUAGES = {
  en: "English",
  tr: "Türkçe",
} as const;

export type Language = keyof typeof SUPPORTED_LANGUAGES;

export const DEFAULT_LANGUAGE: Language = "en";

i18n
  // Tarayıcı dilini otomatik algıla (Accept-Language header, navigator.language vb.)
  .use(LanguageDetector)
  // React entegrasyonu — useTranslation() hook'u aktif eder
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        auth: enAuth,
        channels: enChannels,
        chat: enChat,
        settings: enSettings,
        voice: enVoice,
        landing: enLanding,
      },
      tr: {
        common: trCommon,
        auth: trAuth,
        channels: trChannels,
        chat: trChat,
        settings: trSettings,
        voice: trVoice,
        landing: trLanding,
      },
    },

    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: Object.keys(SUPPORTED_LANGUAGES),

    // Varsayılan namespace — t("save") → common namespace'inden arar
    defaultNS: "common",
    ns: ["common", "auth", "channels", "chat", "settings", "voice", "landing"],

    interpolation: {
      // React zaten XSS koruması sağlıyor, çift escape'e gerek yok
      escapeValue: false,
    },

    detection: {
      // Dil algılama sırası: localStorage → tarayıcı dili
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "language",
      caches: ["localStorage"],
    },
  });

/**
 * Dili değiştir ve localStorage'a kaydet.
 * Kullanıcı giriş yaptıysa backend'e de sync edilir (authStore'dan).
 */
export function changeLanguage(lng: Language): void {
  i18n.changeLanguage(lng);
  localStorage.setItem("language", lng);
}

export default i18n;
