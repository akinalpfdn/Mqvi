import type { SettingsTab } from "../../stores/settingsStore";

/** Single source for section names — the nav and the mobile header must not drift apart. */
export const SETTINGS_TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  profile: "profile",
  appearance: "appearance",
  voice: "voiceSettings",
  security: "security",
  encryption: "encryption",
  "blocked-users": "blockedUsers",
  feedback: "feedback",
  help: "help",
  general: "general",
  "server-general": "general",
  channels: "channels",
  roles: "roles",
  members: "members",
  invites: "invites",
  "join-requests": "joinRequests",
  platform: "platformLiveKitInstances",
  "platform-servers": "platformServersTab",
  "platform-users": "platformUsersTab",
  "platform-reports": "platformReportsTab",
  "platform-server-reports": "platformServerReportsTab",
  "platform-feedback": "platformFeedbackTab",
  "platform-logs": "platformLogsTab",
};
