/**
 * Channel Encryption — Kanal/grup mesajlari icin E2EE sifreleme/cozme katmani.
 *
 * Bu modul messageStore (gonderme) ve useWebSocket (alma) tarafindan
 * cagirilir. Sender Key Protocol primitive'lerini kullanarak:
 * - Gonderme: plaintext → SenderKeyMessage (tek ciphertext, tum uyeler ayni)
 * - Alma: SenderKeyMessage → plaintext
 *
 * Sender Key vs Signal (DM):
 * - DM'de her alici cihaz icin ayri sifreleme yapilir (N ciphertext)
 * - Kanal'da tek sifreleme yapilir, tum uyeler ayni ciphertext'i cozer
 * - Performans avantaji: 100 uyeli kanalda 1 encrypt vs 100 encrypt
 *
 * Sender Key dagitimi:
 * Gonderici ilk mesajda (veya key rotation'da) yeni Sender Key olusturur
 * ve dagitim mesajini sunucuya yukler. Uyeler sender key'i sunucudan
 * ceker ve inbound olarak kaydeder.
 *
 * Key rotation:
 * - Her 100 mesajda otomatik rotation
 * - Her 7 gunde otomatik rotation
 * - Uye cikarilinca rotation (gelecekte)
 */

import * as senderKeyProtocol from "./senderKeyProtocol.js";
import * as e2eeApi from "../api/e2ee.js";
import { useE2EEStore } from "../stores/e2eeStore.js";
import { useServerStore } from "../stores/serverStore.js";
import type { SenderKeyMessage, SenderKeyDistributionData } from "./types.js";
import type { Message, ChannelGroupSessionResponse } from "../types/index.js";

// ──────────────────────────────────
// Encryption (Sender Side)
// ──────────────────────────────────

/**
 * Kanal mesajini Sender Key ile sifreler.
 *
 * Akis:
 * 1. Bu kanal icin outbound sender key var mi kontrol et
 * 2. Yoksa veya rotation gerekiyorsa → yeni distribution olustur + sunucuya yukle
 * 3. encryptGroupMessage ile sifrele
 * 4. SenderKeyMessage doner — JSON.stringify ile ciphertext alanina yazilir
 *
 * @param channelId - Kanal ID'si
 * @param userId - Gonderici kullanici ID
 * @param deviceId - Bu cihazin device ID'si
 * @param plaintext - Sifrelenmemis mesaj metni
 */
export async function encryptChannelMessage(
  channelId: string,
  userId: string,
  deviceId: string,
  plaintext: string
): Promise<SenderKeyMessage> {
  // Rotation gerekli mi kontrol et
  const needsRotation = await senderKeyProtocol.needsSenderKeyRotation(
    channelId,
    userId,
    deviceId
  );

  if (needsRotation) {
    // Yeni Sender Key olustur ve sunucuya yukle
    await createAndUploadDistribution(channelId, userId, deviceId);
  }

  // Sender Key ile sifrele — tek ciphertext, tum uyeler cozer
  return senderKeyProtocol.encryptGroupMessage(
    channelId,
    userId,
    deviceId,
    plaintext
  );
}

/**
 * Yeni Sender Key distribution olusturur ve sunucuya yukler.
 *
 * Sunucu distribution'i saklar ve kanal uyelerine dagitir.
 * Uyeler fetchAndProcessDistributions ile bu distribution'i alir.
 */
async function createAndUploadDistribution(
  channelId: string,
  userId: string,
  deviceId: string
): Promise<void> {
  const distribution = await senderKeyProtocol.createDistribution(
    channelId,
    userId,
    deviceId
  );

  const serverId = useServerStore.getState().activeServerId;
  if (!serverId) throw new Error("No active server");

  await e2eeApi.uploadGroupSession(serverId, channelId, deviceId, {
    session_id: distribution.distributionId,
    session_data: JSON.stringify(distribution),
  });
}

// ──────────────────────────────────
// Decryption (Receiver Side)
// ──────────────────────────────────

/**
 * Alinan E2EE kanal mesajini cozer.
 *
 * Ciphertext alani JSON-serialized SenderKeyMessage icerir.
 * Gondericinin sender key'i ile decrypt edilir.
 *
 * @param senderUserId - Gonderici kullanici ID
 * @param channelId - Kanal ID'si
 * @param ciphertext - JSON string SenderKeyMessage
 * @param senderDeviceId - Gonderici cihaz ID'si
 * @returns Cozulmus plaintext veya null
 */
export async function decryptChannelMessage(
  senderUserId: string,
  channelId: string,
  ciphertext: string,
  senderDeviceId: string
): Promise<string | null> {
  // Sender Key message parse et
  let senderKeyMsg: SenderKeyMessage;
  try {
    senderKeyMsg = JSON.parse(ciphertext);
  } catch {
    console.error("[channelEncryption] Failed to parse SenderKeyMessage");
    return null;
  }

  // Gondericinin sender key'i yoksa sunucudan cek
  try {
    await ensureSenderKeyForDecryption(
      channelId,
      senderUserId,
      senderDeviceId,
      senderKeyMsg.distributionId
    );
  } catch (err) {
    console.error(
      `[channelEncryption] Failed to fetch sender key for ${senderUserId}:${senderDeviceId}:`,
      err
    );
    return null;
  }

  // Sender Key ile decrypt
  return senderKeyProtocol.decryptGroupMessage(
    channelId,
    senderUserId,
    senderDeviceId,
    senderKeyMsg
  );
}

/**
 * Gondericinin sender key'inin mevcut oldugundan emin olur.
 * Yoksa sunucudan distribution'i ceker ve isle.
 */
async function ensureSenderKeyForDecryption(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string,
  distributionId: string
): Promise<void> {
  // Mevcut sender key var mi ve dogru distribution mi kontrol et
  const needsKey = await senderKeyProtocol.needsSenderKeyRotation(
    channelId,
    senderUserId,
    senderDeviceId
  );

  if (!needsKey) return;

  // Sunucudan distribution'lari cek
  const serverId = useServerStore.getState().activeServerId;
  if (!serverId) return;

  const res = await e2eeApi.fetchGroupSessions(serverId, channelId);
  if (!res.success || !res.data) return;

  // Bu gondericinin distribution'ini bul ve isle
  for (const session of res.data) {
    if (
      session.sender_user_id === senderUserId &&
      session.sender_device_id === senderDeviceId
    ) {
      try {
        const distribution: SenderKeyDistributionData = JSON.parse(
          session.session_data
        );

        if (distribution.distributionId === distributionId) {
          await senderKeyProtocol.processDistribution(
            channelId,
            senderUserId,
            senderDeviceId,
            distribution
          );
          return;
        }
      } catch {
        console.error(
          "[channelEncryption] Failed to parse distribution data"
        );
      }
    }
  }
}

/**
 * Message dizisindeki E2EE mesajlari toplu decrypt eder.
 *
 * fetchMessages/fetchOlderMessages sonrasi cagrilir.
 * Plaintext mesajlar (encryption_version=0) olduklari gibi birakilir.
 * Decrypt edilemeyen mesajlar content=null olarak isaretlenir.
 *
 * @param messages - Backend'den gelen ham mesaj dizisi
 * @returns Decrypt edilmis mesaj dizisi (ayni sira)
 */
export async function decryptChannelMessages(
  messages: Message[]
): Promise<Message[]> {
  const result: Message[] = [];

  for (const msg of messages) {
    if (
      msg.encryption_version === 1 &&
      msg.ciphertext &&
      msg.sender_device_id
    ) {
      try {
        const plaintext = await decryptChannelMessage(
          msg.user_id,
          msg.channel_id,
          msg.ciphertext,
          msg.sender_device_id
        );

        result.push({
          ...msg,
          content: plaintext,
        });
      } catch (err) {
        console.error(
          `[channelEncryption] Failed to decrypt msg ${msg.id}:`,
          err
        );
        // Decrypt basarisiz — decryption error olarak kaydet
        useE2EEStore.getState().addDecryptionError({
          messageId: msg.id,
          channelId: msg.channel_id,
          error: err instanceof Error ? err.message : "Decryption failed",
          timestamp: Date.now(),
        });
        result.push({ ...msg, content: null });
      }
    } else {
      // Plaintext mesaj — oldugu gibi birak
      result.push(msg);
    }
  }

  return result;
}
