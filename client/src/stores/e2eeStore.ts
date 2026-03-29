/**
 * E2EE Store — E2EE state management.
 */

import { create } from "zustand";
import * as deviceManager from "../crypto/deviceManager";
import * as keyBackup from "../crypto/keyBackup";
import * as keyStorage from "../crypto/keyStorage";
import * as e2eeApi from "../api/e2ee";
import type { DeviceInfo } from "../types";
import { useMessageStore } from "./messageStore";
import { useDMStore } from "./dmStore";
import { useChannelStore } from "./channelStore";
import { useServerStore } from "./serverStore";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

export type E2EEInitStatus =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "needs_setup"
  | "error";

export type DecryptionError = {
  messageId: string;
  channelId: string;
  error: string;
  timestamp: number;
};

type E2EEState = {
  initStatus: E2EEInitStatus;
  /** null = not yet registered */
  localDeviceId: string | null;
  devices: DeviceInfo[];
  hasRecoveryBackup: boolean;
  decryptionErrors: DecryptionError[];
  isGeneratingKeys: boolean;
  initError: string | null;
  /** Show non-blocking recovery password prompt when E2EE first becomes relevant. */
  showRecoveryPrompt: boolean;
  /** Whether the user dismissed the recovery prompt in this session. */
  recoveryPromptDismissed: boolean;

  // ─── Actions ───

  initialize: (userId: string) => Promise<void>;
  setupNewDevice: (userId: string, displayName?: string) => Promise<void>;
  restoreFromRecovery: (password: string) => Promise<boolean>;
  setRecoveryPassword: (password: string) => Promise<void>;
  completeRecoverySetup: (password: string) => Promise<void>;
  /** Check if recovery password prompt should be shown (E2EE active + no backup). */
  checkAndPromptRecovery: () => void;
  dismissRecoveryPrompt: () => void;
  fetchDevices: () => Promise<void>;
  removeDevice: (deviceId: string) => Promise<void>;
  addDecryptionError: (error: DecryptionError) => void;
  clearDecryptionErrors: (channelId: string) => void;
  /** Generate and upload new prekey batch when server signals low count. */
  handlePrekeyLow: () => Promise<void>;
  /** Reset Zustand state on logout. IndexedDB keys are preserved. */
  reset: () => Promise<void>;
};

// ──────────────────────────────────
// Store
// ──────────────────────────────────

export const useE2EEStore = create<E2EEState>((set, get) => ({
  initStatus: "uninitialized",
  localDeviceId: null,
  devices: [],
  hasRecoveryBackup: false,
  decryptionErrors: [],
  isGeneratingKeys: false,
  initError: null,
  showRecoveryPrompt: false,
  recoveryPromptDismissed: false,

  initialize: async (userId: string) => {
    const current = get().initStatus;
    if (current === "initializing" || current === "ready") return;

    set({ initStatus: "initializing", initError: null });

    try {
      let hasKeys = await keyStorage.hasLocalKeys();

      // Clear keys if logged in as a different user
      if (hasKeys) {
        const registration = await keyStorage.getRegistrationData();
        if (registration && registration.userId !== userId) {
          await keyStorage.clearAllE2EEData();
          hasKeys = false;
        }
      }

      if (hasKeys) {
        const deviceId = await deviceManager.getLocalDeviceId();

        // Re-register if server lost this device (DB reset, manual deletion).
        // Without this: prekey upload FK error + other devices can't create envelopes.
        if (deviceId) {
          try {
            const devicesRes = await e2eeApi.listMyDevices();
            const existsOnServer = devicesRes.success && devicesRes.data?.some(
              (d) => d.device_id === deviceId
            );
            if (!existsOnServer) {
              await deviceManager.reRegisterDevice(deviceId);
            }
          } catch {
            // Network error — will retry during prekey refresh
          }
        }

        set({
          initStatus: "ready",
          localDeviceId: deviceId,
        });

        // Background: prekey check + device list + backup status + deferred recovery prompt
        get().handlePrekeyLow();
        get().fetchDevices();
        checkRecoveryBackup(set);
        scheduleDeferredRecoveryCheck(get);
      } else {
        // No local keys — check for server backup.
        // Backup existence implies E2EE was previously used and backed up → show restore flow.
        try {
          const backupRes = await e2eeApi.downloadKeyBackup();
          if (backupRes.success && backupRes.data) {
            set({
              initStatus: "needs_setup",
              localDeviceId: null,
              hasRecoveryBackup: true,
            });
            return;
          }
        } catch {
          // Backup check failed — continue to auto key generation
        }

        // No backup — silently generate keys regardless of whether other devices exist.
        // If no E2EE activity: keys sit idle, no user-facing popup.
        // If E2EE activates later: recovery password prompt will appear at that time.
        // Old keys on other devices are independent (per-device identity) so no conflict.
        await get().setupNewDevice(userId);
        scheduleDeferredRecoveryCheck(get);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "E2EE initialization failed";
      console.error("[e2eeStore] initialize error:", message);
      set({
        initStatus: "error",
        initError: message,
      });
    }
  },

  setupNewDevice: async (userId: string, displayName?: string) => {
    set({ isGeneratingKeys: true, initError: null });

    try {
      const deviceId = await deviceManager.registerNewDevice(
        userId,
        displayName
      );

      set({
        initStatus: "ready",
        localDeviceId: deviceId,
        isGeneratingKeys: false,
      });

      get().fetchDevices();

      // Invalidate message cache so messages get re-decrypted
      useMessageStore.getState().invalidateFetchCache();
      useDMStore.getState().invalidateFetchCache();

      const activeChannelId = useChannelStore.getState().selectedChannelId;
      if (activeChannelId) {
        useMessageStore.getState().fetchMessages(activeChannelId);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Device setup failed";
      console.error("[e2eeStore] setupNewDevice error:", message);
      set({
        initError: message,
        isGeneratingKeys: false,
      });
    }
  },

  restoreFromRecovery: async (password: string) => {
    set({ isGeneratingKeys: true, initError: null });

    try {
      const response = await e2eeApi.downloadKeyBackup();
      if (!response.success || !response.data) {
        set({
          initError: "No backup found on server",
          isGeneratingKeys: false,
        });
        return false;
      }

      const restored = await keyBackup.restoreFromBackup(
        {
          encryptedData: response.data.encrypted_data,
          nonce: response.data.nonce,
          salt: response.data.salt,
        },
        password
      );

      if (!restored) {
        set({
          initError: "Invalid recovery password",
          isGeneratingKeys: false,
        });
        return false;
      }

      // New device ID for self-fanout; legacy ID kept for old envelope matching.
      const newDeviceId = await deviceManager.registerRestoredDevice();

      set({
        initStatus: "ready",
        localDeviceId: newDeviceId,
        hasRecoveryBackup: true,
        isGeneratingKeys: false,
      });

      get().handlePrekeyLow();
      get().fetchDevices();

      // Invalidate cache — messages will now decrypt with restored keys
      useMessageStore.getState().invalidateFetchCache();
      useDMStore.getState().invalidateFetchCache();

      const activeChannelId = useChannelStore.getState().selectedChannelId;
      if (activeChannelId) {
        useMessageStore.getState().fetchMessages(activeChannelId);
      }

      return true;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Recovery failed";
      console.error("[e2eeStore] restoreFromRecovery error:", message);
      set({
        initError: message,
        isGeneratingKeys: false,
      });
      return false;
    }
  },

  setRecoveryPassword: async (password: string) => {
    try {
      const backup = await keyBackup.createBackup(password);

      const response = await e2eeApi.uploadKeyBackup({
        version: backup.version,
        algorithm: backup.algorithm,
        encrypted_data: backup.encryptedData,
        nonce: backup.nonce,
        salt: backup.salt,
      });

      if (!response.success) {
        throw new Error(response.error ?? "Failed to upload key backup");
      }

      set({ hasRecoveryBackup: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to set recovery password";
      console.error("[e2eeStore] setRecoveryPassword error:", message);
      throw err;
    }
  },

  completeRecoverySetup: async (password: string) => {
    try {
      await get().setRecoveryPassword(password);
      set({ showRecoveryPrompt: false });
    } catch (err) {
      throw err;
    }
  },

  checkAndPromptRecovery: () => {
    const { initStatus, hasRecoveryBackup, recoveryPromptDismissed, showRecoveryPrompt } = get();
    if (initStatus !== "ready" || hasRecoveryBackup || recoveryPromptDismissed || showRecoveryPrompt) return;

    // Check if any DM channel or the active server has E2EE enabled
    const dmChannels = useDMStore.getState().channels;
    const activeServer = useServerStore.getState().activeServer;

    const hasE2EEActivity =
      dmChannels.some((ch) => ch.e2ee_enabled) ||
      (activeServer?.e2ee_enabled === true);

    if (hasE2EEActivity) {
      set({ showRecoveryPrompt: true });
    }
  },

  dismissRecoveryPrompt: () => {
    set({ showRecoveryPrompt: false, recoveryPromptDismissed: true });
  },

  fetchDevices: async () => {
    try {
      const response = await e2eeApi.listMyDevices();
      if (response.success && response.data) {
        set({ devices: response.data });
      }
    } catch (err) {
      console.error("[e2eeStore] fetchDevices error:", err);
    }
  },

  removeDevice: async (deviceId: string) => {
    try {
      const response = await e2eeApi.removeDevice(deviceId);
      if (response.success) {
        set((state) => ({
          devices: state.devices.filter((d) => d.device_id !== deviceId),
        }));
      }
    } catch (err) {
      console.error("[e2eeStore] removeDevice error:", err);
      throw err;
    }
  },

  addDecryptionError: (error: DecryptionError) => {
    set((state) => {
      const updated = [...state.decryptionErrors, error];
      // Cap at 500 entries to prevent memory leak
      return { decryptionErrors: updated.length > 500 ? updated.slice(-500) : updated };
    });
  },

  clearDecryptionErrors: (channelId: string) => {
    set((state) => ({
      decryptionErrors: state.decryptionErrors.filter(
        (e) => e.channelId !== channelId
      ),
    }));
  },

  handlePrekeyLow: async () => {
    const deviceId = get().localDeviceId;
    if (!deviceId) return;

    try {
      await deviceManager.refreshPreKeys(deviceId);
    } catch (err) {
      console.error("[e2eeStore] handlePrekeyLow error:", err);
    }
  },

  reset: async () => {
    // Only reset Zustand state on logout.
    // IndexedDB keys and server device registration are PRESERVED
    // so re-login on the same device doesn't require key restore.
    // Device removal is done explicitly via Settings > Encryption.
    set({
      initStatus: "uninitialized",
      localDeviceId: null,
      devices: [],
      hasRecoveryBackup: false,
      decryptionErrors: [],
      isGeneratingKeys: false,
      initError: null,
      showRecoveryPrompt: false,
      recoveryPromptDismissed: false,
    });
  },
}));

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/** Check recovery backup status in background. Silently continues on error. */
async function checkRecoveryBackup(
  set: (partial: Partial<E2EEState>) => void
): Promise<void> {
  try {
    const response = await e2eeApi.downloadKeyBackup();
    if (response.success && response.data) {
      set({ hasRecoveryBackup: true });
    }
  } catch {
    // Non-critical — silently continue
  }
}

/**
 * Schedule a deferred recovery prompt check.
 * DM channels and servers may not be loaded yet when init completes,
 * so we wait a few seconds for stores to populate from the WS ready event.
 */
function scheduleDeferredRecoveryCheck(
  get: () => E2EEState
): void {
  setTimeout(() => {
    get().checkAndPromptRecovery();
  }, 5000);
}
