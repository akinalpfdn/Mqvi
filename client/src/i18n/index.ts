/**
 * i18n configuration — i18next + react-i18next setup.
 *
 * Namespaces: common, auth, channels, chat, settings, voice, landing, servers, dm, e2ee.
 * Supported languages: EN (fallback), TR.
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
import enServers from "./locales/en/servers.json";
import enDM from "./locales/en/dm.json";
import enE2EE from "./locales/en/e2ee.json";

// ─── TR Translation Files ───
import trCommon from "./locales/tr/common.json";
import trAuth from "./locales/tr/auth.json";
import trChannels from "./locales/tr/channels.json";
import trChat from "./locales/tr/chat.json";
import trSettings from "./locales/tr/settings.json";
import trVoice from "./locales/tr/voice.json";
import trLanding from "./locales/tr/landing.json";
import trServers from "./locales/tr/servers.json";
import trDM from "./locales/tr/dm.json";
import trE2EE from "./locales/tr/e2ee.json";

export const SUPPORTED_LANGUAGES = {
  en: "English",
  tr: "Türkçe",
} as const;

export type Language = keyof typeof SUPPORTED_LANGUAGES;

export const DEFAULT_LANGUAGE: Language = "en";

i18n
  .use(LanguageDetector)
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
        servers: enServers,
        dm: enDM,
        e2ee: enE2EE,
      },
      tr: {
        common: trCommon,
        auth: trAuth,
        channels: trChannels,
        chat: trChat,
        settings: trSettings,
        voice: trVoice,
        landing: trLanding,
        servers: trServers,
        dm: trDM,
        e2ee: trE2EE,
      },
    },

    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: Object.keys(SUPPORTED_LANGUAGES),

    defaultNS: "common",
    ns: ["common", "auth", "channels", "chat", "settings", "voice", "landing", "servers", "dm", "e2ee"],

    interpolation: {
      // React already handles XSS protection
      escapeValue: false,
    },

    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "language",
      caches: ["localStorage"],
    },
  });

/** Changes language and persists to localStorage. */
export function changeLanguage(lng: Language): void {
  i18n.changeLanguage(lng);
  localStorage.setItem("language", lng);
}

export default i18n;
