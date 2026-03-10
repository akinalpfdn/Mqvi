import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock all external crypto/api dependencies before importing the store
vi.mock("../crypto/deviceManager", () => ({
  getLocalDeviceId: vi.fn(),
  registerNewDevice: vi.fn(),
  registerRestoredDevice: vi.fn(),
  refreshPreKeys: vi.fn(),
  reRegisterDevice: vi.fn(),
}));
vi.mock("../crypto/keyBackup", () => ({
  createBackup: vi.fn(),
  restoreFromBackup: vi.fn(),
}));
vi.mock("../crypto/keyStorage", () => ({
  hasLocalKeys: vi.fn(),
  getRegistrationData: vi.fn(),
  clearAllE2EEData: vi.fn(),
}));
vi.mock("../api/e2ee", () => ({
  listMyDevices: vi.fn(),
  removeDevice: vi.fn(),
  uploadKeyBackup: vi.fn(),
  downloadKeyBackup: vi.fn(),
}));
vi.mock("./messageStore", () => ({
  useMessageStore: { getState: () => ({ invalidateFetchCache: vi.fn(), fetchMessages: vi.fn() }) },
}));
vi.mock("./dmStore", () => ({
  useDMStore: { getState: () => ({ invalidateFetchCache: vi.fn() }) },
}));
vi.mock("./channelStore", () => ({
  useChannelStore: { getState: () => ({ selectedChannelId: null }) },
}));

import { useE2EEStore } from "./e2eeStore";
import type { DecryptionError } from "./e2eeStore";

function resetStore() {
  useE2EEStore.setState({
    initStatus: "uninitialized",
    localDeviceId: null,
    devices: [],
    hasRecoveryBackup: false,
    decryptionErrors: [],
    isGeneratingKeys: false,
    initError: null,
  });
}

describe("e2eeStore", () => {
  beforeEach(() => {
    resetStore();
  });

  // ─── Decryption Error Management ───

  describe("addDecryptionError", () => {
    it("should add a decryption error", () => {
      const error: DecryptionError = {
        messageId: "m1",
        channelId: "ch1",
        error: "Missing session key",
        timestamp: Date.now(),
      };
      useE2EEStore.getState().addDecryptionError(error);
      expect(useE2EEStore.getState().decryptionErrors).toHaveLength(1);
      expect(useE2EEStore.getState().decryptionErrors[0].messageId).toBe("m1");
    });

    it("should cap errors at 500 entries", () => {
      const store = useE2EEStore.getState();
      // Pre-fill with 500 errors
      const existing: DecryptionError[] = Array.from({ length: 500 }, (_, i) => ({
        messageId: `m${i}`,
        channelId: "ch1",
        error: "test",
        timestamp: i,
      }));
      useE2EEStore.setState({ decryptionErrors: existing });

      // Add one more — should trim to last 500
      store.addDecryptionError({
        messageId: "m_new",
        channelId: "ch1",
        error: "test",
        timestamp: 999,
      });

      const errors = useE2EEStore.getState().decryptionErrors;
      expect(errors).toHaveLength(500);
      expect(errors[errors.length - 1].messageId).toBe("m_new");
      // First entry (m0) should have been dropped
      expect(errors[0].messageId).toBe("m1");
    });
  });

  describe("clearDecryptionErrors", () => {
    it("should clear errors for a specific channel", () => {
      useE2EEStore.setState({
        decryptionErrors: [
          { messageId: "m1", channelId: "ch1", error: "err", timestamp: 1 },
          { messageId: "m2", channelId: "ch2", error: "err", timestamp: 2 },
          { messageId: "m3", channelId: "ch1", error: "err", timestamp: 3 },
        ],
      });
      useE2EEStore.getState().clearDecryptionErrors("ch1");
      const errors = useE2EEStore.getState().decryptionErrors;
      expect(errors).toHaveLength(1);
      expect(errors[0].channelId).toBe("ch2");
    });
  });

  // ─── Reset ───

  describe("reset", () => {
    it("should reset all state to defaults", async () => {
      useE2EEStore.setState({
        initStatus: "ready",
        localDeviceId: "dev1",
        devices: [{
          id: "1", user_id: "u1", device_id: "dev1", display_name: "Test",
          identity_key: "", signed_prekey: "", signed_prekey_id: 0,
          signed_prekey_signature: "", registration_id: 0,
          last_seen_at: "", created_at: "",
        }],
        hasRecoveryBackup: true,
        decryptionErrors: [{ messageId: "m1", channelId: "ch1", error: "err", timestamp: 1 }],
        isGeneratingKeys: true,
        initError: "old error",
      });

      await useE2EEStore.getState().reset();
      const state = useE2EEStore.getState();

      expect(state.initStatus).toBe("uninitialized");
      expect(state.localDeviceId).toBeNull();
      expect(state.devices).toHaveLength(0);
      expect(state.hasRecoveryBackup).toBe(false);
      expect(state.decryptionErrors).toHaveLength(0);
      expect(state.isGeneratingKeys).toBe(false);
      expect(state.initError).toBeNull();
    });
  });

  // ─── Initial State ───

  describe("initial state", () => {
    it("should start uninitialized with no device", () => {
      const state = useE2EEStore.getState();
      expect(state.initStatus).toBe("uninitialized");
      expect(state.localDeviceId).toBeNull();
      expect(state.devices).toHaveLength(0);
      expect(state.hasRecoveryBackup).toBe(false);
      expect(state.isGeneratingKeys).toBe(false);
    });
  });
});
