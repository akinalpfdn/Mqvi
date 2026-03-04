/**
 * DM Encryption — DM mesajlari icin E2EE sifreleme/cozme katmani.
 *
 * Bu modul dmStore (gonderme) ve useWebSocket (alma) tarafindan
 * cagirilir. Signal Protocol primitive'lerini kullanarak:
 * - Gonderme: plaintext → EncryptedEnvelope[] (her alici cihaz icin)
 * - Alma: EncryptedEnvelope[] → plaintext (bu cihaz icin)
 *
 * Self-fanout:
 * Gonderici kendi diger cihazlari icin de sifreler — bu sayede
 * ayni kullanicinin tum cihazlari gonderdigi mesajlari gorebilir.
 *
 * Prekey bundle fetch:
 * Ilk mesajda alicinin prekey bundle'i sunucudan cekilir ve
 * X3DH key agreement ile session kurulur. Sonraki mesajlarda
 * mevcut session kullanilir (Double Ratchet).
 */

import * as signalProtocol from "./signalProtocol";
import * as e2eeApi from "../api/e2ee";
import { useE2EEStore } from "../stores/e2eeStore";
import type { EncryptedEnvelope, PreKeyBundleResponse, DMMessage } from "../types";
import type { SignalWireMessage } from "./types";

// ──────────────────────────────────
// Encryption (Sender Side)
// ──────────────────────────────────

/**
 * DM mesajini tum alici cihazlar icin sifreler.
 *
 * Akis:
 * 1. Alicinin tum cihazlari icin prekey bundle cek
 * 2. Her cihaz icin session kur (yoksa X3DH) + sifrele
 * 3. Gondericinin diger cihazlari icin de sifrele (self-fanout)
 * 4. EncryptedEnvelope[] doner — JSON.stringify ile ciphertext alanina yazilir
 *
 * @param currentUserId - Gonderici kullanici ID
 * @param recipientUserId - Alici kullanici ID
 * @param localDeviceId - Bu cihazin device ID'si
 * @param plaintext - Sifrelenmemis mesaj metni
 */
export async function encryptDMMessage(
  currentUserId: string,
  recipientUserId: string,
  localDeviceId: string,
  plaintext: string
): Promise<EncryptedEnvelope[]> {
  const envelopes: EncryptedEnvelope[] = [];

  // 1. Alicinin tum cihaz bundle'larini cek
  const recipientBundles = await e2eeApi.fetchPreKeyBundles(recipientUserId);
  if (!recipientBundles.success || !recipientBundles.data) {
    throw new Error("Failed to fetch recipient prekey bundles");
  }

  // Her alici cihaz icin sifrele
  for (const bundle of recipientBundles.data) {
    const envelope = await encryptForDevice(
      recipientUserId,
      bundle,
      localDeviceId,
      plaintext
    );
    envelopes.push(envelope);
  }

  // 2. Self-fanout: kendi diger cihazlari icin de sifrele
  // (Alice Device A → Alice Device B, Alice Device C, ...)
  const selfBundles = await e2eeApi.fetchPreKeyBundles(currentUserId);
  if (selfBundles.success && selfBundles.data) {
    for (const bundle of selfBundles.data) {
      // Kendi device'imizi atla — kendimize sifrelemeye gerek yok
      if (bundle.device_id === localDeviceId) continue;

      const envelope = await encryptForDevice(
        currentUserId,
        bundle,
        localDeviceId,
        plaintext
      );
      envelopes.push(envelope);
    }
  }

  return envelopes;
}

/**
 * Tek bir cihaz icin sifreleme yapar.
 *
 * Session yoksa prekey bundle ile X3DH key agreement yapilir,
 * ardindan Double Ratchet ile mesaj sifrelenir.
 *
 * @param userId - Hedef kullanici ID
 * @param bundle - Cihazin prekey bundle'i
 * @param senderDeviceId - Gondericinin device ID'si
 * @param plaintext - Sifrelenmemis metin
 */
async function encryptForDevice(
  userId: string,
  bundle: PreKeyBundleResponse,
  senderDeviceId: string,
  plaintext: string
): Promise<EncryptedEnvelope> {
  // Session yoksa kur (X3DH key agreement)
  if (!(await signalProtocol.hasSessionFor(userId, bundle.device_id))) {
    await signalProtocol.processPreKeyBundle(userId, bundle.device_id, {
      identityKey: bundle.identity_key,
      // signing_key ile signed prekey imzasi dogrulanir.
      // Yoksa identity_key'e fallback — eski cihazlar signing_key gondermemis olabilir.
      signingKey: bundle.signing_key ?? bundle.identity_key,
      signedPrekeyId: bundle.signed_prekey_id,
      signedPrekey: bundle.signed_prekey,
      signedPrekeySignature: bundle.signed_prekey_signature,
      oneTimePrekeyId: bundle.one_time_prekey_id ?? undefined,
      oneTimePrekey: bundle.one_time_prekey ?? undefined,
      registrationId: bundle.registration_id,
    });
  }

  // Double Ratchet ile sifrele
  const wireMessage = await signalProtocol.encryptMessage(
    userId,
    bundle.device_id,
    plaintext
  );

  return {
    sender_device_id: senderDeviceId,
    recipient_device_id: bundle.device_id,
    message_type: wireMessage.type,
    // Tam SignalWireMessage JSON olarak saklanir —
    // header (ratchet key, message number) + ciphertext + preKeyInfo (varsa)
    ciphertext: JSON.stringify(wireMessage),
  };
}

// ──────────────────────────────────
// Decryption (Receiver Side)
// ──────────────────────────────────

/**
 * Alinan E2EE DM mesajini cozer.
 *
 * Ciphertext alani JSON-serialized EncryptedEnvelope[] icerir.
 * Bu cihazin device_id'sine ait envelope bulunur ve decrypt edilir.
 *
 * @param senderUserId - Gonderici kullanici ID (mesajin user_id alani)
 * @param ciphertext - JSON string EncryptedEnvelope[]
 * @param senderDeviceId - Gonderici cihaz ID (mesajin sender_device_id alani)
 * @returns Cozulmus plaintext veya null (bu cihaz icin envelope yoksa)
 */
export async function decryptDMMessage(
  senderUserId: string,
  ciphertext: string,
  senderDeviceId: string
): Promise<string | null> {
  const localDeviceId = useE2EEStore.getState().localDeviceId;
  if (!localDeviceId) return null;

  // Envelope dizisini parse et
  let envelopes: EncryptedEnvelope[];
  try {
    envelopes = JSON.parse(ciphertext);
  } catch {
    console.error("[dmEncryption] Failed to parse ciphertext envelopes");
    return null;
  }

  // Bu cihaz icin envelope bul
  const myEnvelope = envelopes.find(
    (env) => env.recipient_device_id === localDeviceId
  );

  if (!myEnvelope) {
    // Bu cihaz icin envelope yok — mesaj bu cihaz kaydedilmeden once gonderilmis olabilir
    return null;
  }

  // Wire message parse
  let wireMessage: SignalWireMessage;
  try {
    wireMessage = JSON.parse(myEnvelope.ciphertext);
  } catch {
    console.error("[dmEncryption] Failed to parse wire message");
    return null;
  }

  // Signal Protocol ile decrypt
  // senderDeviceId: mesajin sender_device_id alani — gondericinin hangi cihazdan gonderdigini belirtir
  return signalProtocol.decryptMessage(
    senderUserId,
    senderDeviceId,
    wireMessage
  );
}

/**
 * DMMessage dizisindeki E2EE mesajlari toplu decrypt eder.
 *
 * fetchMessages/fetchOlderMessages sonrasi cagrilir.
 * Plaintext mesajlar (encryption_version=0) olduklari gibi birakilir.
 * Decrypt edilemeyen mesajlar content=null olarak isaretlenir.
 *
 * @param messages - Backend'den gelen ham mesaj dizisi
 * @returns Decrypt edilmis mesaj dizisi (ayni sira)
 */
export async function decryptDMMessages(
  messages: DMMessage[]
): Promise<DMMessage[]> {
  const result: DMMessage[] = [];

  for (const msg of messages) {
    if (
      msg.encryption_version === 1 &&
      msg.ciphertext &&
      msg.sender_device_id
    ) {
      try {
        const plaintext = await decryptDMMessage(
          msg.user_id,
          msg.ciphertext,
          msg.sender_device_id
        );

        result.push({
          ...msg,
          content: plaintext,
        });
      } catch (err) {
        console.error(
          `[dmEncryption] Failed to decrypt msg ${msg.id}:`,
          err
        );
        // Decrypt basarisiz — decryption error olarak kaydet
        useE2EEStore.getState().addDecryptionError({
          messageId: msg.id,
          channelId: msg.dm_channel_id,
          error: err instanceof Error ? err.message : "Decryption failed",
          timestamp: Date.now(),
        });
        result.push({ ...msg, content: null });
      }
    } else {
      // Plaintext mesaj — olduğu gibi birak
      result.push(msg);
    }
  }

  return result;
}
