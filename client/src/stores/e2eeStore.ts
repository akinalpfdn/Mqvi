/**
 * E2EE Store — Zustand ile E2EE state yonetimi.
 *
 * Bu store, E2EE islemlerinin frontend genelindeki durumunu yonetir:
 * - Cihaz kayit durumu (henuz kurulmamis / hazir / hata)
 * - Lokal cihaz bilgileri (deviceId, registrationId)
 * - Kullanicinin kayitli cihazlari (diger cihazlar listesi)
 * - Recovery password yedek durumu
 * - Decryption hatalari (UI'da "mesaj cozulemedi" gosterimi)
 * - Anahtar uretimi durumu (key generation UI feedback)
 *
 * Yasam dongusu:
 * 1. App baslar → useE2EE hook'u initialize() cagirir
 * 2. IndexedDB kontrol edilir — anahtarlar var mi?
 * 3. Varsa → initStatus = "ready"
 * 4. Yoksa → initStatus = "needs_setup" → NewDeviceSetup modal gosterilir
 * 5. Kullanici logout → reset() cagirilir → tum E2EE verisi temizlenir
 *
 * Slice pattern: E2EE concern'u ayri store'da, authStore/messageStore'dan bagimsiz.
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

// ──────────────────────────────────
// Types
// ──────────────────────────────────

/**
 * E2EE baslangic durumu.
 *
 * - uninitialized: Henuz kontrol edilmedi
 * - initializing: IndexedDB kontrol ediliyor
 * - ready: Anahtarlar mevcut, E2EE aktif
 * - needs_setup: Anahtarlar yok, yeni cihaz kurulumu gerekli
 * - error: Baslangic hatasi
 */
export type E2EEInitStatus =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "needs_setup"
  | "needs_recovery_password"
  | "error";

/**
 * Decryption hatasi — UI'da mesaj cozulemediginde gosterilir.
 */
export type DecryptionError = {
  /** Mesaj ID'si */
  messageId: string;
  /** Kanal veya DM kanal ID'si */
  channelId: string;
  /** Hata mesaji */
  error: string;
  /** Hata zamani */
  timestamp: number;
};

type E2EEState = {
  /** E2EE baslangic durumu */
  initStatus: E2EEInitStatus;

  /** Bu cihazin device ID'si (null = henuz kaydedilmemis) */
  localDeviceId: string | null;

  /** Kullanicinin kayitli cihazlari (sunucudan) */
  devices: DeviceInfo[];

  /** Kullanicinin recovery password yedegi var mi */
  hasRecoveryBackup: boolean;

  /** Decryption hatalari listesi */
  decryptionErrors: DecryptionError[];

  /** Anahtar uretimi devam ediyor mu (loading indicator) */
  isGeneratingKeys: boolean;

  /** Baslangic hatasi (varsa) */
  initError: string | null;

  // ─── Actions ───

  /**
   * initialize — E2EE sistemini baslatir.
   *
   * App boot'ta cagrilir (useE2EE hook'u uzerinden).
   * IndexedDB'de lokal anahtarlar var mi kontrol eder.
   *
   * @param userId - Mevcut kullanicinin ID'si
   */
  initialize: (userId: string) => Promise<void>;

  /**
   * setupNewDevice — Yeni cihaz kurar.
   *
   * NewDeviceSetup modal'indan cagrilir.
   * Tum E2EE anahtarlarini uretir ve sunucuya kaydeder.
   *
   * @param userId - Kullanici ID'si
   * @param displayName - Cihaz adi (opsiyonel)
   */
  setupNewDevice: (userId: string, displayName?: string) => Promise<void>;

  /**
   * restoreFromRecovery — Recovery password ile anahtarlari geri yukler.
   *
   * NewDeviceSetup modal'indaki "Recovery ile Geri Yukle" seceneginden cagrilir.
   *
   * @param password - Recovery password
   * @returns true ise basarili, false ise sifre yanlis
   */
  restoreFromRecovery: (password: string) => Promise<boolean>;

  /**
   * setRecoveryPassword — Recovery password belirler/gunceller.
   *
   * Settings > Encryption > Recovery Password'den cagrilir.
   *
   * @param password - Yeni recovery password
   */
  setRecoveryPassword: (password: string) => Promise<void>;

  /**
   * completeRecoverySetup — Ilk kurulumda zorunlu recovery password belirler.
   *
   * initStatus === "needs_recovery_password" iken NewDeviceSetup modal'indan cagrilir.
   * Recovery password'u kaydeder ve initStatus'u "ready" yapar.
   *
   * @param password - Recovery password
   */
  completeRecoverySetup: (password: string) => Promise<void>;

  /**
   * fetchDevices — Kullanicinin cihaz listesini sunucudan ceker.
   */
  fetchDevices: () => Promise<void>;

  /**
   * removeDevice — Uzak cihazi siler.
   *
   * Settings > Encryption > Device Management'tan cagrilir.
   *
   * @param deviceId - Silinecek cihaz ID'si
   */
  removeDevice: (deviceId: string) => Promise<void>;

  /**
   * addDecryptionError — Decryption hatasi ekler.
   * WebSocket mesaj aliminda decrypt basarisiz oldugunda cagrilir.
   */
  addDecryptionError: (error: DecryptionError) => void;

  /**
   * clearDecryptionErrors — Belirli bir kanalin decryption hatalarini temizler.
   */
  clearDecryptionErrors: (channelId: string) => void;

  /**
   * handlePrekeyLow — Sunucu prekey_low event'i gonderdiginde cagrilir.
   * Yeni prekey batch'i uretir ve yukler.
   */
  handlePrekeyLow: () => Promise<void>;

  /**
   * reset — Tum E2EE state'ini sifirlar ve lokal verileri temizler.
   * Logout'ta cagrilir.
   */
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

  initialize: async (userId: string) => {
    // Tekrar initialize etme — zaten baslatildiysa skip
    const current = get().initStatus;
    if (current === "initializing" || current === "ready" || current === "needs_recovery_password") return;

    set({ initStatus: "initializing", initError: null });

    try {
      // IndexedDB'de lokal anahtarlar var mi kontrol et
      let hasKeys = await keyStorage.hasLocalKeys();

      // Farkli kullanici ile giris yapilmissa eski anahtarlari temizle
      // ki asagidaki "anahtarlar yok" akisi calissin
      if (hasKeys) {
        const registration = await keyStorage.getRegistrationData();
        if (registration && registration.userId !== userId) {
          await keyStorage.clearAllE2EEData();
          hasKeys = false;
        }
      }

      if (hasKeys) {
        // Anahtarlar mevcut — device ID'yi oku
        const deviceId = await deviceManager.getLocalDeviceId();

        // Sunucuda cihaz hala var mi kontrol et — yoksa yeniden kaydet.
        // Sunucu DB sifirlanmissa veya cihaz silinmisse bu gereklidir.
        // Olmadan: prekey upload FK hatasi + diger cihazlar bu cihaz icin
        // envelope olusturamaz.
        if (deviceId) {
          try {
            const devicesRes = await e2eeApi.listMyDevices();
            const existsOnServer = devicesRes.success && devicesRes.data?.some(
              (d) => d.device_id === deviceId
            );
            if (!existsOnServer) {
              // Sunucu cihazi tanimiyor — mevcut anahtarlarla yeniden kaydet
              await deviceManager.reRegisterDevice(deviceId);
            }
          } catch {
            // Network hatasi — devam et, prekey refresh'te tekrar denenecek
          }
        }

        set({
          initStatus: "ready",
          localDeviceId: deviceId,
        });

        // Arka planda: prekey kontrolu + cihaz listesi + backup durumu
        get().handlePrekeyLow();
        get().fetchDevices();
        checkRecoveryBackup(set);
      } else {
        // Anahtarlar yok — sunucuda backup var mi kontrol et
        try {
          const backupRes = await e2eeApi.downloadKeyBackup();
          if (backupRes.success && backupRes.data) {
            // Backup mevcut — kullaniciya restore secenegi sun
            set({
              initStatus: "needs_setup",
              localDeviceId: null,
              hasRecoveryBackup: true,
            });
            return;
          }
        } catch {
          // Backup kontrol basarisiz — devam et, otomatik key olustur
        }

        // Backup yok — kullanicinin baska cihazi var mi kontrol et.
        // Baska cihaz varsa otomatik key olusturma — kullanici once
        // diger cihazda recovery password belirlemeli.
        // Baska cihaz yoksa ilk kez kullanan kullanici → otomatik setup.
        try {
          const devicesRes = await e2eeApi.listMyDevices();
          if (devicesRes.success && devicesRes.data && devicesRes.data.length > 0) {
            // Baska cihaz mevcut ama backup yok — setup gerekli
            set({
              initStatus: "needs_setup",
              localDeviceId: null,
              hasRecoveryBackup: false,
            });
            return;
          }
        } catch {
          // Device kontrol basarisiz — guvenli tarafta kal, setup iste
          set({
            initStatus: "needs_setup",
            localDeviceId: null,
            hasRecoveryBackup: false,
          });
          return;
        }

        // Hic cihaz yok — ilk kez kullanan kullanici, otomatik key olustur
        // Anahtarlar arkaplanda olusturulur, sonra kullanici zorunlu
        // recovery password belirleyene kadar uygulama engellenir.
        await get().setupNewDevice(userId);
        // setupNewDevice initStatus'u "ready" yapar — biz uzerine yaziyoruz
        set({ initStatus: "needs_recovery_password" });
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

      // Arka planda cihaz listesini cek
      get().fetchDevices();

      // Mesaj cache'ini temizle ve aktif kanali yeniden fetch et
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
      // Sunucudan backup'i indir
      const response = await e2eeApi.downloadKeyBackup();
      if (!response.success || !response.data) {
        set({
          initError: "No backup found on server",
          isGeneratingKeys: false,
        });
        return false;
      }

      // Recovery password ile coz
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

      // Yeni device ID uret + eski ID'yi legacy olarak sakla.
      // Yeni ID: self-fanout calisir (her cihaz farkli ID).
      // Legacy ID: eski mesajlardaki envelope'lar eslesir.
      // messageCache: backup'tan gelen + mevcut cache korunur.
      const newDeviceId = await deviceManager.registerRestoredDevice();

      set({
        initStatus: "ready",
        localDeviceId: newDeviceId,
        hasRecoveryBackup: true,
        isGeneratingKeys: false,
      });

      // Prekey havuzunu doldur + cihaz listesi
      get().handlePrekeyLow();
      get().fetchDevices();

      // Mesaj cache'ini temizle ve aktif kanali yeniden fetch et.
      // initStatus artik "ready" — mesajlar decrypt edilecek.
      useMessageStore.getState().invalidateFetchCache();
      useDMStore.getState().invalidateFetchCache();

      // Aktif kanali yeniden fetch et — kullanici beklemek zorunda kalmasin
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
      // Backup olustur
      const backup = await keyBackup.createBackup(password);

      // Sunucuya yukle
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
      throw err; // UI'da toast gosterilsin
    }
  },

  completeRecoverySetup: async (password: string) => {
    try {
      await get().setRecoveryPassword(password);
      set({ initStatus: "ready" });
    } catch (err) {
      // setRecoveryPassword zaten throw ediyor — tekrar throw et
      throw err;
    }
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
        // Listeden cikar
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
      // Bellek sızıntısını önle — max 500 hata tut, eski girişleri sil
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
    // Logout'ta sadece Zustand state sifirlanir.
    // IndexedDB'deki anahtarlar ve sunucudaki cihaz KORUNUR.
    // Neden: Ayni cihazdaki tekrar giriste kullanici anahtarlarini
    // yeniden restore etmek zorunda kalmaz. Ayrica baglanti kopusu
    // gibi senaryolarda anahtarlar kaybolmaz.
    // Cihaz silme islemi sadece Settings > Encryption > Remove Device'tan yapilir.
    set({
      initStatus: "uninitialized",
      localDeviceId: null,
      devices: [],
      hasRecoveryBackup: false,
      decryptionErrors: [],
      isGeneratingKeys: false,
      initError: null,
    });
  },
}));

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/**
 * Recovery backup durumunu kontrol eder.
 * Arka planda calisir, hata olursa sessizce devam eder.
 */
async function checkRecoveryBackup(
  set: (partial: Partial<E2EEState>) => void
): Promise<void> {
  try {
    const response = await e2eeApi.downloadKeyBackup();
    if (response.success && response.data) {
      set({ hasRecoveryBackup: true });
    }
  } catch {
    // Sessizce devam et — backup kontrolu kritik degil
  }
}
