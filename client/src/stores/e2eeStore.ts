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
import { getOpenConversations } from "./uiStore";
import { mapWithConcurrency } from "../utils/concurrency";
import { useServerStore } from "./serverStore";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

export type E2EEInitStatus =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "error";

export type DecryptionError = {
  messageId: string;
  channelId: string;
  error: string;
  timestamp: number;
};

/**
 * Whether this device can encrypt right now.
 *
 * The send and edit paths used to fold this into the same condition that chose the encrypted
 * branch, so a target that mandates encryption while the device was still initialising fell
 * through to the plaintext branch. The server refuses that, but only because the server checks —
 * the client has to say no on its own, and say which of the two reasons it is.
 */
export function canEncrypt(e2ee: Pick<E2EEState, "initStatus" | "localDeviceId">): boolean {
  return e2ee.initStatus === "ready" && !!e2ee.localDeviceId;
}

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

        // Anything opened while init was still running was cached without plaintext. The keys
        // exist now, so refill it — otherwise encrypted history stays blank until a restart.
        void refillAfterKeysReady(false);

        // Background: prekey check + device list + backup status + deferred recovery prompt
        get().handlePrekeyLow();
        get().fetchDevices();
        checkRecoveryBackup(set);
        scheduleDeferredRecoveryCheck(get);
      } else {
        // No local keys — check backup status (don't block on it).
        // Even if backup exists, silently generate new keys so the app is usable immediately.
        // If E2EE is active, the non-blocking recovery prompt will offer restore option.
        // This prevents the blocking modal for users who never used E2EE but had
        // a backup from the old mandatory recovery password flow.
        try {
          const backupRes = await e2eeApi.downloadKeyBackup();
          if (backupRes.success && backupRes.data) {
            set({ hasRecoveryBackup: true });
          }
        } catch {
          // Non-critical — continue
        }

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

      // New key material — everything held was decrypted with keys that no longer apply.
      void refillAfterKeysReady(true);
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

      // Restored keys — what is held was decrypted with the pre-restore key material.
      void refillAfterKeysReady(true);

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
    // Every server the user is in, not just the active one — an encrypted server they happen not to
    // be looking at right now still means their keys matter.
    const { servers, activeServer } = useServerStore.getState();

    // activeServer stays in the check as a floor: e2ee_enabled is optional on the list item, so a
    // list delivered by an older server binary mid-deploy would carry undefined for every entry.
    const hasE2EEActivity =
      dmChannels.some((ch) => ch.e2ee_enabled) ||
      servers.some((sv) => sv.e2ee_enabled === true) ||
      activeServer?.e2ee_enabled === true;

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

/** Ceiling on parallel refill fetches — same reasoning as the reconnect resync. */
const REFILL_CONCURRENCY = 4;

/**
 * True when something we hold is encrypted but carries no plaintext — content cached while the
 * keys were still loading. On the way into `ready` no genuine decrypt has run yet, so a null here
 * can only be gated content, never a real decryption failure.
 */
function hasGatedContent(): boolean {
  for (const messages of Object.values(useMessageStore.getState().messagesByChannel)) {
    if (messages.some((m) => m.encryption_version === 1 && m.content == null)) return true;
  }
  for (const messages of Object.values(useDMStore.getState().messagesByChannel)) {
    if (messages.some((m) => m.encryption_version === 1 && m.content == null)) return true;
  }
  return false;
}

/**
 * Drops content cached before the keys existed and refills what is on screen. Every path that
 * reaches `ready` calls this — the bug it closes was that only two of the three did, so the
 * ordinary "this device already has keys" launch left encrypted history blank until a restart.
 *
 * `force` is for the paths that just replaced the key material (new device, recovery restore):
 * there the whole cache is stale by definition, whether or not it looks gated.
 */
async function refillAfterKeysReady(force: boolean): Promise<void> {
  if (!force && !hasGatedContent()) return;

  useMessageStore.getState().invalidateFetchCache();
  useDMStore.getState().invalidateFetchCache();

  // Every open conversation, not just the selected one. The invalidate above emptied all of them,
  // and split view keeps several views mounted — a mounted view whose channelId did not change has
  // no effect left to re-run, so it would sit blank until the user clicked elsewhere and back.
  // Bounded for the same reason the reconnect resync is: one request per tab, all at once.
  await mapWithConcurrency(getOpenConversations(), REFILL_CONCURRENCY, async (open) => {
    try {
      if (open.type === "text") {
        await useMessageStore.getState().fetchMessages(open.channelId, open.serverId);
      } else {
        await useDMStore.getState().fetchMessages(open.channelId);
      }
    } catch (err) {
      // One unreachable conversation must not abandon the rest — mapWithConcurrency stops every
      // worker on the first rejection.
      console.warn("[e2ee] refill failed", { channelId: open.channelId, err });
    }
  });
}

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
