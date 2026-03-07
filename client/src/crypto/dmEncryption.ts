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
import * as keyStorage from "./keyStorage";
import * as deviceManager from "./deviceManager";
import { decodePayload, type E2EEPayload } from "./e2eePayload";
import { useE2EEStore } from "../stores/e2eeStore";
import type { EncryptedEnvelope, PreKeyBundleResponse, DMMessage } from "../types";
import type { SignalWireMessage } from "./types";

// ──────────────────────────────────
// Sent Message Plaintext Cache
// ──────────────────────────────────

/**
 * Gönderilen DM mesajlarının plaintext FIFO cache'i.
 *
 * Signal Protocol, göndericinin kendi cihazına envelope oluşturamaz
 * (kendi cihazınıza Double Ratchet session kuramazsınız). Bu nedenle
 * WS echo geldiğinde gönderici kendi mesajını decrypt edemez.
 *
 * Çözüm (Signal Desktop / WhatsApp modeli):
 * Plaintext'i göndermeden ÖNCE in-memory FIFO queue'ya yazarız.
 * WS event geldiğinde pop ederek content'i alırız.
 * API response sonrası IndexedDB'ye kalıcı olarak kaydederiz.
 *
 * İki aşamalı cache:
 * 1. preSendQueue: channelId → E2EEPayload[] (FIFO) — API call öncesi push
 * 2. IndexedDB messageCache: messageId → content — API response sonrası persist
 *
 * Race condition handling:
 * - Normal akış: API response → IndexedDB cache → WS event → IndexedDB hit
 * - Nadir durum: WS event → preSendQueue pop → API response → IndexedDB persist
 * preSendQueue SYNC olarak API call öncesinde set edildiği için,
 * WS event her zaman cache'i bulabilir (WS ancak sunucu mesajı işledikten
 * sonra gelir — ki bu API call'dan sonradır).
 */
const preSendQueue = new Map<string, E2EEPayload[]>();

/**
 * Edit işlemleri için in-memory cache.
 *
 * Edit'te messageId zaten bilinir, bu yüzden direkt Map<messageId, payload>
 * kullanılır (FIFO queue gerekmez).
 */
const editCache = new Map<string, E2EEPayload>();

/**
 * Gönderim öncesi plaintext'i FIFO queue'ya ekler.
 *
 * sendMessage çağrısında, API call'dan ÖNCE çağrılır.
 * Bu sayede WS echo geldiğinde (API call'dan sonra) cache'te bulunur.
 *
 * @param dmChannelId - DM kanalı ID'si
 * @param payload - Şifrelenmemiş mesaj içeriği + dosya anahtarları
 */
export function pushSentPlaintext(dmChannelId: string, payload: E2EEPayload): void {
  const queue = preSendQueue.get(dmChannelId);
  if (queue) {
    queue.push(payload);
  } else {
    preSendQueue.set(dmChannelId, [payload]);
  }
}

/**
 * WS event geldiğinde kendi mesajımızın plaintext'ini FIFO'dan çeker.
 *
 * FIFO sırası doğrudur çünkü aynı kanala gönderilen mesajlar
 * sunucuda sıralı işlenir ve WS broadcast'i sıralı gelir.
 *
 * @param dmChannelId - DM kanalı ID'si
 * @returns Plaintext payload veya null (cache miss)
 */
export function popSentPlaintext(dmChannelId: string): E2EEPayload | null {
  const queue = preSendQueue.get(dmChannelId);
  if (!queue || queue.length === 0) return null;

  const payload = queue.shift()!;
  if (queue.length === 0) preSendQueue.delete(dmChannelId);
  return payload;
}

/**
 * Gönderim başarısız olduğunda pre-send cache'i temizler.
 *
 * API call hata verirse queue'daki son eklenen entry kaldırılır.
 * LIFO (son eklenen, ilk çıkar) — çünkü hata veren send'in push'u en sondadır.
 */
export function discardLastSentPlaintext(dmChannelId: string): void {
  const queue = preSendQueue.get(dmChannelId);
  if (!queue || queue.length === 0) return;

  queue.pop();
  if (queue.length === 0) preSendQueue.delete(dmChannelId);
}

/**
 * Edit öncesi plaintext'i cache'e yazar.
 *
 * Edit'te messageId zaten bilinir — direkt Map'e yaz.
 *
 * @param messageId - Düzenlenen mesajın ID'si
 * @param payload - Yeni plaintext payload
 */
export function cacheEditPlaintext(messageId: string, payload: E2EEPayload): void {
  editCache.set(messageId, payload);
}

/**
 * Edit cache'inden plaintext okur ve siler.
 *
 * @param messageId - Mesaj ID'si
 * @returns Plaintext payload veya null
 */
export function popEditPlaintext(messageId: string): E2EEPayload | null {
  const payload = editCache.get(messageId) ?? null;
  if (payload) editCache.delete(messageId);
  return payload;
}

/**
 * API response sonrası plaintext'i IndexedDB'ye kalıcı olarak yazar.
 *
 * In-memory cache geçicidir — sayfa yenilenince kaybolur.
 * IndexedDB persist ile fetch (tarihsel yükleme) sırasında da
 * kendi mesajlarımızın content'ine erişilebilir.
 *
 * @param messageId - Sunucunun atadığı mesaj ID'si
 * @param dmChannelId - DM kanalı ID'si
 * @param content - Plaintext mesaj metni
 */
export async function persistSentPlaintext(
  messageId: string,
  dmChannelId: string,
  content: string
): Promise<void> {
  await keyStorage.cacheDecryptedMessage({
    messageId,
    channelId: "",
    dmChannelId,
    content,
    timestamp: Date.now(),
  });
}

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

  // Alicinin hic cihazi/anahtari yoksa sifreli mesaj gonderilemez.
  // Bu durum, alici henuz E2EE kurulumu yapmamissa olusur.
  // Auto key generation aktif oldugundan nadir gorulen bir edge case.
  if (recipientBundles.data.length === 0) {
    throw new Error("RECIPIENT_NO_KEYS");
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
  //
  // ONEMLI: Self-fanout her zaman PreKey mesaj olmali.
  // Recovery restore sonrasi sadece key material var, session state yok.
  // Regular (non-PreKey) mesajlar session state gerektirir — decrypt edilemez.
  // Her mesajda session silip yeniden kurarak PreKey zorluyoruz.
  const selfBundles = await e2eeApi.fetchPreKeyBundles(currentUserId);
  if (selfBundles.success && selfBundles.data) {
    for (const bundle of selfBundles.data) {
      // Kendi device'imizi atla — kendimize sifrelemeye gerek yok
      if (bundle.device_id === localDeviceId) continue;

      // Mevcut session'i sil — encryptForDevice PreKey mesaj olusturmaya zorla.
      // Bu sayede recovery restore eden cihaz, sadece key material ile
      // (session state olmadan) bu mesaji decrypt edebilir.
      await keyStorage.deleteSession(currentUserId, bundle.device_id);

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
 * Alinan E2EE DM mesajini cozer ve structured payload'i parse eder.
 *
 * Ciphertext alani JSON-serialized EncryptedEnvelope[] icerir.
 * Bu cihazin device_id'sine ait envelope bulunur ve decrypt edilir.
 * Decrypt sonrasi decodePayload ile content + file_keys ayristirilir.
 *
 * @param senderUserId - Gonderici kullanici ID (mesajin user_id alani)
 * @param ciphertext - JSON string EncryptedEnvelope[]
 * @param senderDeviceId - Gonderici cihaz ID (mesajin sender_device_id alani)
 * @returns Cozulmus payload (content + file_keys) veya null
 */
export async function decryptDMMessage(
  senderUserId: string,
  ciphertext: string,
  senderDeviceId: string
): Promise<E2EEPayload | null> {
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

  // Bu cihaz icin envelope bul — once current device ID, sonra legacy ID'leri dene.
  // Recovery restore sonrasi yeni device ID alinir ama eski mesajlardaki
  // envelope'lar eski device ID'ye sifrelenmistir. Legacy ID'ler bu durumu cozer.
  let myEnvelope = envelopes.find(
    (env) => env.recipient_device_id === localDeviceId
  );

  if (!myEnvelope) {
    // Legacy device ID'leri kontrol et (recovery restore sonrasi eski ID'ler)
    const legacyIds = await deviceManager.getLegacyDeviceIds();
    for (const legacyId of legacyIds) {
      myEnvelope = envelopes.find(
        (env) => env.recipient_device_id === legacyId
      );
      if (myEnvelope) break;
    }
  }

  if (!myEnvelope) {
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
  try {
    const plaintext = await signalProtocol.decryptMessage(
      senderUserId,
      senderDeviceId,
      wireMessage
    );

    if (plaintext === null) return null;

    // Structured payload parse — content + file_keys ayristir
    return decodePayload(plaintext);
  } catch (err) {
    console.error("[dmEncryption] decrypt failed:", err);
    throw err;
  }
}

/**
 * DMMessage dizisindeki E2EE mesajlari toplu decrypt eder.
 *
 * fetchMessages/fetchOlderMessages sonrasi cagrilir.
 * Plaintext mesajlar (encryption_version=0) olduklari gibi birakilir.
 * Decrypt edilemeyen mesajlar content=null olarak isaretlenir.
 *
 * Basarili decrypt sonrasi:
 * - content + e2ee_file_keys mesaja set edilir
 * - Mesaj IndexedDB cache'e yazilir (client-side search icin)
 *
 * @param messages - Backend'den gelen ham mesaj dizisi
 * @returns Decrypt edilmis mesaj dizisi (ayni sira)
 */
export async function decryptDMMessages(
  messages: DMMessage[]
): Promise<DMMessage[]> {
  const result: DMMessage[] = [];
  const toCache: import("./types").CachedDecryptedMessage[] = [];

  for (const msg of messages) {
    if (
      msg.encryption_version === 1 &&
      msg.ciphertext &&
      msg.sender_device_id
    ) {
      // 1) IndexedDB cache kontrol — daha once decrypt edilmis mesaji
      // tekrar decrypt etme (Double Ratchet stateful — tekrar decrypt
      // ratchet state'i bozar ve OperationError verir).
      try {
        const cached = await keyStorage.getCachedDecryptedMessage(msg.id);
        if (cached) {
          result.push({ ...msg, content: cached.content });
          continue;
        }
      } catch {
        // Cache read hatasi — devam et, decrypt dene
      }

      // 2) Signal Protocol ile decrypt
      try {
        const payload = await decryptDMMessage(
          msg.user_id,
          msg.ciphertext,
          msg.sender_device_id
        );

        if (payload) {
          result.push({
            ...msg,
            content: payload.content,
            e2ee_file_keys: payload.file_keys,
          });

          if (payload.content) {
            toCache.push({
              messageId: msg.id,
              channelId: "",
              dmChannelId: msg.dm_channel_id,
              content: payload.content,
              timestamp: new Date(msg.created_at).getTime(),
            });
          }
        } else {
          // Envelope bulunamadi — bu cihaz icin sifrelenmemis
          result.push({ ...msg, content: null });
        }
      } catch (err) {
        console.error(
          `[dmEncryption] Failed to decrypt msg ${msg.id}:`,
          err
        );
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

  // Toplu cache yazimi — tek transaction ile performansli
  if (toCache.length > 0) {
    keyStorage.cacheDecryptedMessages(toCache).catch((err) => {
      console.error("[dmEncryption] Failed to cache messages:", err);
    });
  }

  return result;
}
