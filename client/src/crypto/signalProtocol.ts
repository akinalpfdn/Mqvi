/**
 * Signal Protocol — DM (1-1) sifreleme katmani.
 *
 * X3DH (Extended Triple Diffie-Hellman) + Double Ratchet implementasyonu.
 * Bu modül tüm DM mesajlarinin E2EE sifreleme/cozme islemlerini yapar.
 *
 * Kriptografik primitifler:
 * - X25519: Diffie-Hellman key agreement (@noble/curves)
 * - Ed25519: Dijital imza (@noble/curves)
 * - HKDF-SHA-256: Key derivation (@noble/hashes)
 * - HMAC-SHA-256: Chain key progression (@noble/hashes)
 * - AES-256-GCM: Mesaj sifreleme (Web Crypto API)
 *
 * Neden @noble/curves?
 * Electron ^33 Chrome 130 kullanir — Web Crypto API'de X25519 destegi
 * Chrome 133'te eklendi. @noble/curves pure JS implementasyondur,
 * Cure53 + Trail of Bits tarafindan audit edilmistir.
 *
 * Referans:
 * - X3DH: https://signal.org/docs/specifications/x3dh/
 * - Double Ratchet: https://signal.org/docs/specifications/doubleratchet/
 */

import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import * as keyStorage from "./keyStorage";
import {
  type StoredIdentityKeyPair,
  type StoredSignedPreKey,
  type StoredPreKey,
  type StoredSession,
  type SessionState,
  type MessageHeader,
  type SignalWireMessage,
  type PreKeyMessageInfo,
  SignalMessageType,
  MAX_SKIP,
  PREKEY_BATCH_SIZE,
  HKDF_INFO,
} from "./types";

// ──────────────────────────────────
// Base64 Utilities
// ──────────────────────────────────

/**
 * Uint8Array → base64 string donusumu.
 * Network transferinde ve IndexedDB composite key'lerde kullanilir.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * base64 string → Uint8Array donusumu.
 */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ──────────────────────────────────
// Key Generation
// ──────────────────────────────────

/**
 * Yeni X25519 key pair uretir.
 *
 * X25519 (Curve25519 uzerinde ECDH):
 * - 32 byte private key (rastgele)
 * - 32 byte public key (private key'den turetilir)
 * - Diffie-Hellman key agreement icin kullanilir
 */
function generateX25519KeyPair(): StoredIdentityKeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Tum E2EE anahtarlarini uretir ve IndexedDB'ye kaydeder.
 *
 * Yeni cihaz kurulumunda cagrilir. Uretilen anahtarlar:
 * 1. Identity key pair (X25519) — cihazin uzun omurlu kimligi
 * 2. Signing key pair (Ed25519) — signed prekey imzalamak icin
 * 3. Signed prekey — orta vadeli, identity key ile imzali
 * 4. One-time prekey'ler (100 adet) — tek kullanimlik
 * 5. Registration ID — rastgele 16-bit sayi
 *
 * @returns Sunucuya yuklenecek public key'ler ve registration bilgisi
 */
export async function generateAllKeys(): Promise<{
  identityPublicKey: string;
  signingPublicKey: string;
  signedPreKey: {
    id: number;
    publicKey: string;
    signature: string;
  };
  oneTimePreKeys: Array<{ id: number; publicKey: string }>;
  registrationId: number;
}> {
  // 1. Identity key pair (X25519)
  const identityKeyPair = generateX25519KeyPair();
  await keyStorage.saveIdentityKeyPair(identityKeyPair);

  // 2. Ed25519 signing key pair — ayni seed'den turetilir
  // Not: X25519 ve Ed25519 farkli key formatlarinda calisir.
  // Ayni 32-byte seed hem X25519 hem Ed25519 icin kullanilabilir
  // ancak urettikleri public key'ler FARKLIDIR.
  const signingPublicKey = ed25519.getPublicKey(identityKeyPair.privateKey);
  await keyStorage.saveSigningKeyPair({
    publicKey: signingPublicKey,
    privateKey: identityKeyPair.privateKey,
  });

  // 3. Signed prekey
  const signedPreKey = await generateSignedPreKey(
    identityKeyPair.privateKey,
    1
  );
  await keyStorage.saveSignedPreKey(signedPreKey);

  // 4. One-time prekey'ler (100 adet)
  const preKeys = generatePreKeys(1, PREKEY_BATCH_SIZE);
  await keyStorage.savePreKeys(preKeys);

  // 5. Registration ID — Signal protocol icin benzersiz cihaz tanimlayicisi
  // 16-bit rastgele sayi (0-65535), cakisma olasiligi ihmal edilebilir
  const registrationId = crypto.getRandomValues(new Uint16Array(1))[0];

  return {
    identityPublicKey: toBase64(identityKeyPair.publicKey),
    signingPublicKey: toBase64(signingPublicKey),
    signedPreKey: {
      id: signedPreKey.id,
      publicKey: toBase64(signedPreKey.publicKey),
      signature: toBase64(signedPreKey.signature),
    },
    oneTimePreKeys: preKeys.map((pk) => ({
      id: pk.id,
      publicKey: toBase64(pk.publicKey),
    })),
    registrationId,
  };
}

/**
 * Signed prekey uretir ve identity key ile imzalar.
 *
 * Signed prekey, X3DH'da kullanilir. Identity key'in Ed25519 karsiligi
 * ile imzalanarak sahte prekey enjeksiyonu onlenir (MITM koruması).
 *
 * @param identityPrivateKey - 32-byte identity private key (Ed25519 imza icin)
 * @param id - Prekey ID'si (sunucuda takip icin)
 */
async function generateSignedPreKey(
  identityPrivateKey: Uint8Array,
  id: number
): Promise<StoredSignedPreKey> {
  const keyPair = generateX25519KeyPair();

  // Ed25519 ile imzala — prekey'in sahte olmadigini kanitlar
  const signature = ed25519.sign(keyPair.publicKey, identityPrivateKey);

  return {
    id,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    signature,
    createdAt: Date.now(),
  };
}

/**
 * Batch one-time prekey uretir.
 *
 * @param start - Baslangic ID'si (onceki batch'in sonundan devam)
 * @param count - Uretilecek adet
 */
function generatePreKeys(start: number, count: number): StoredPreKey[] {
  const preKeys: StoredPreKey[] = [];
  for (let i = 0; i < count; i++) {
    const keyPair = generateX25519KeyPair();
    preKeys.push({
      id: start + i,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });
  }
  return preKeys;
}

/**
 * Ek one-time prekey'ler uretir ve IndexedDB'ye kaydeder.
 * Sunucu prekey_low event'i gonderdiginde cagrilir.
 *
 * @param startId - Baslangic ID'si
 * @param count - Uretilecek adet
 * @returns Sunucuya yuklenecek public key'ler
 */
export async function generateMorePreKeys(
  startId: number,
  count: number = PREKEY_BATCH_SIZE
): Promise<Array<{ id: number; publicKey: string }>> {
  const preKeys = generatePreKeys(startId, count);
  await keyStorage.savePreKeys(preKeys);
  return preKeys.map((pk) => ({
    id: pk.id,
    publicKey: toBase64(pk.publicKey),
  }));
}

/**
 * Signed prekey rotate eder.
 * Periyodik olarak cagrilir (ornegin haftada bir).
 *
 * @param newId - Yeni prekey ID'si
 * @returns Sunucuya yuklenecek yeni signed prekey bilgileri
 */
export async function rotateSignedPreKey(newId: number): Promise<{
  id: number;
  publicKey: string;
  signature: string;
}> {
  const identityKeyPair = await keyStorage.getIdentityKeyPair();
  if (!identityKeyPair) {
    throw new Error("Identity key pair not found — device not initialized");
  }

  const newSignedPreKey = await generateSignedPreKey(
    identityKeyPair.privateKey,
    newId
  );
  await keyStorage.saveSignedPreKey(newSignedPreKey);

  return {
    id: newSignedPreKey.id,
    publicKey: toBase64(newSignedPreKey.publicKey),
    signature: toBase64(newSignedPreKey.signature),
  };
}

// ──────────────────────────────────
// X3DH Key Agreement
// ──────────────────────────────────

/**
 * PreKey bundle'i dogrulanmis mi kontrol eder.
 * Signed prekey'in imzasini Ed25519 ile verify eder.
 */
function verifySignedPreKey(
  identityKey: Uint8Array,
  signedPrekey: Uint8Array,
  signature: Uint8Array
): boolean {
  // identity key X25519 formunda, ama imza Ed25519 ile yapilmis.
  // Sunucu, signing public key'i (Ed25519) ayri sakliyor,
  // ama basitlik icin identity key'in Ed25519 karsiligini kullaniyoruz.
  // Not: Gercekte signing key ayri tutulur, burada sadece verify yapiyoruz.
  try {
    return ed25519.verify(signature, signedPrekey, identityKey);
  } catch {
    return false;
  }
}

/**
 * X3DH key agreement — gondericinin tarafi (Alice).
 *
 * Alice, Bob'a ilk mesajini gondermek istediginde:
 * 1. Bob'un prekey bundle'ini sunucudan ceker
 * 2. Bu fonksiyon ile shared secret hesaplar
 * 3. Shared secret'i Double Ratchet'in root key'i olarak kullanir
 *
 * DH hesaplamalari (4-DH veya 3-DH):
 * - DH1 = DH(IKa, SPKb)  — Alice identity + Bob signed prekey
 * - DH2 = DH(EKa, IKb)   — Alice ephemeral + Bob identity
 * - DH3 = DH(EKa, SPKb)  — Alice ephemeral + Bob signed prekey
 * - DH4 = DH(EKa, OPKb)  — Alice ephemeral + Bob one-time prekey (varsa)
 *
 * @param bundle - Bob'un prekey bundle'i (sunucudan)
 * @returns Session state + PreKey mesaj bilgileri
 */
export async function processPreKeyBundle(
  userId: string,
  deviceId: string,
  bundle: {
    identityKey: string;       // base64 X25519 public
    signingKey: string;        // base64 Ed25519 public
    signedPrekeyId: number;
    signedPrekey: string;      // base64 X25519 public
    signedPrekeySignature: string;  // base64 Ed25519 signature
    oneTimePrekeyId?: number;
    oneTimePrekey?: string;    // base64 X25519 public (varsa)
    registrationId: number;
  }
): Promise<void> {
  const identityKeyPair = await keyStorage.getIdentityKeyPair();
  if (!identityKeyPair) {
    throw new Error("Identity key pair not found — device not initialized");
  }

  // Bundle decode
  const theirIdentityKey = fromBase64(bundle.identityKey);
  const theirSigningKey = fromBase64(bundle.signingKey);
  const theirSignedPrekey = fromBase64(bundle.signedPrekey);
  const theirSignature = fromBase64(bundle.signedPrekeySignature);
  const theirOneTimePrekey = bundle.oneTimePrekey
    ? fromBase64(bundle.oneTimePrekey)
    : null;

  // Signed prekey imzasini dogrula
  if (!verifySignedPreKey(theirSigningKey, theirSignedPrekey, theirSignature)) {
    throw new Error("Signed prekey signature verification failed");
  }

  // Ephemeral key pair uret
  const ephemeralKeyPair = generateX25519KeyPair();

  // DH hesaplamalari
  const dh1 = x25519.getSharedSecret(
    identityKeyPair.privateKey,
    theirSignedPrekey
  );
  const dh2 = x25519.getSharedSecret(
    ephemeralKeyPair.privateKey,
    theirIdentityKey
  );
  const dh3 = x25519.getSharedSecret(
    ephemeralKeyPair.privateKey,
    theirSignedPrekey
  );

  // Shared secret birlestir
  let dhConcat: Uint8Array;
  if (theirOneTimePrekey) {
    const dh4 = x25519.getSharedSecret(
      ephemeralKeyPair.privateKey,
      theirOneTimePrekey
    );
    dhConcat = concatBytes(dh1, dh2, dh3, dh4);
  } else {
    dhConcat = concatBytes(dh1, dh2, dh3);
  }

  // HKDF ile root key + chain key turet
  const masterSecret = hkdf(
    sha256,
    dhConcat,
    new Uint8Array(32), // salt (zeros — X3DH spec)
    new TextEncoder().encode(HKDF_INFO.ROOT_KEY),
    64 // 32 bytes root key + 32 bytes chain key
  );

  const rootKey = masterSecret.slice(0, 32);
  const chainKey = masterSecret.slice(32, 64);

  // Session state olustur
  const sessionState: SessionState = {
    rootKey,
    sendingChainKey: chainKey,
    receivingChainKey: null,
    sendingRatchetKeyPair: ephemeralKeyPair,
    receivingRatchetKey: theirSignedPrekey,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendChainLength: 0,
    skippedMessageKeys: [],
  };

  // TOFU — ilk gorulme, otomatik guvenil
  await keyStorage.saveTrustedIdentity({
    userId,
    deviceId,
    identityKey: theirIdentityKey,
    firstSeen: Date.now(),
    verified: false,
  });

  // Session kaydet
  const session: StoredSession = {
    userId,
    deviceId,
    state: sessionState,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // PreKey message info'yu metadata olarak kaydet
  // (encryptMessage'da kullanilacak — ilk mesaj PreKey mesajidir)
  await keyStorage.setMetadata(`prekey_info:${userId}:${deviceId}`, {
    registrationId: (await keyStorage.getRegistrationData())?.registrationId ?? 0,
    identityKey: toBase64(identityKeyPair.publicKey),
    ephemeralKey: toBase64(ephemeralKeyPair.publicKey),
    signedPrekeyId: bundle.signedPrekeyId,
    oneTimePrekeyId: bundle.oneTimePrekeyId,
  });

  await keyStorage.saveSession(session);
}

/**
 * X3DH key agreement — alicinin tarafi (Bob).
 *
 * Bob, Alice'in PreKey mesajini aldiginda cagrilir.
 * Alice'in gonderdigi ephemeral key ve kullanilan prekey ID'leri
 * ile ayni shared secret'i hesaplar.
 */
export async function processPreKeyMessage(
  senderUserId: string,
  senderDeviceId: string,
  preKeyInfo: PreKeyMessageInfo
): Promise<SessionState> {
  const identityKeyPair = await keyStorage.getIdentityKeyPair();
  if (!identityKeyPair) {
    throw new Error("Identity key pair not found");
  }

  const senderIdentityKey = fromBase64(preKeyInfo.identityKey);
  const senderEphemeralKey = fromBase64(preKeyInfo.ephemeralKey);

  // Signed prekey'i bul
  const signedPreKey = await keyStorage.getSignedPreKey(
    preKeyInfo.signedPrekeyId
  );
  if (!signedPreKey) {
    throw new Error(
      `Signed prekey ${preKeyInfo.signedPrekeyId} not found`
    );
  }

  // DH hesaplamalari (Bob tarafi — sira Alice'in tersi)
  const dh1 = x25519.getSharedSecret(
    signedPreKey.privateKey,
    senderIdentityKey
  );
  const dh2 = x25519.getSharedSecret(
    identityKeyPair.privateKey,
    senderEphemeralKey
  );
  const dh3 = x25519.getSharedSecret(
    signedPreKey.privateKey,
    senderEphemeralKey
  );

  let dhConcat: Uint8Array;

  // One-time prekey kullanildiysa
  if (preKeyInfo.oneTimePrekeyId !== undefined) {
    const otpk = await keyStorage.getPreKey(preKeyInfo.oneTimePrekeyId);
    if (otpk) {
      const dh4 = x25519.getSharedSecret(
        otpk.privateKey,
        senderEphemeralKey
      );
      dhConcat = concatBytes(dh1, dh2, dh3, dh4);
      // One-time prekey tuketildi — sil
      await keyStorage.deletePreKey(preKeyInfo.oneTimePrekeyId);
    } else {
      // OTP key bulunamazsa 3-DH ile devam et (guvenlik biraz azalir)
      dhConcat = concatBytes(dh1, dh2, dh3);
    }
  } else {
    dhConcat = concatBytes(dh1, dh2, dh3);
  }

  // HKDF ile root key + chain key
  const masterSecret = hkdf(
    sha256,
    dhConcat,
    new Uint8Array(32),
    new TextEncoder().encode(HKDF_INFO.ROOT_KEY),
    64
  );

  const rootKey = masterSecret.slice(0, 32);
  const chainKey = masterSecret.slice(32, 64);

  // Bob'un session state'i — Alice'in gonderdigi ratchet key ile baslar
  const newRatchetKeyPair = generateX25519KeyPair();

  // Bob DH ratchet step yapar: yeni key pair + DH hesaplamasi
  const dhOutput = x25519.getSharedSecret(
    newRatchetKeyPair.privateKey,
    senderEphemeralKey
  );
  const ratchetResult = hkdf(
    sha256,
    dhOutput,
    rootKey,
    new TextEncoder().encode(HKDF_INFO.ROOT_KEY),
    64
  );

  const sessionState: SessionState = {
    rootKey: ratchetResult.slice(0, 32),
    sendingChainKey: ratchetResult.slice(32, 64),
    receivingChainKey: chainKey,
    sendingRatchetKeyPair: newRatchetKeyPair,
    receivingRatchetKey: senderEphemeralKey,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendChainLength: 0,
    skippedMessageKeys: [],
  };

  // TOFU
  await keyStorage.saveTrustedIdentity({
    userId: senderUserId,
    deviceId: senderDeviceId,
    identityKey: senderIdentityKey,
    firstSeen: Date.now(),
    verified: false,
  });

  // Session kaydet
  await keyStorage.saveSession({
    userId: senderUserId,
    deviceId: senderDeviceId,
    state: sessionState,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return sessionState;
}

// ──────────────────────────────────
// Double Ratchet — Encryption
// ──────────────────────────────────

/**
 * Mesaj sifreler (Double Ratchet).
 *
 * Mevcut session uzerinden plaintext'i sifreler.
 * Her mesajda chain key ilerletilir (forward secrecy).
 *
 * @param userId - Alici kullanici ID'si
 * @param deviceId - Alici cihaz ID'si
 * @param plaintext - Sifrelenmemis mesaj (UTF-8)
 * @returns Wire format mesaj (gonderime hazir)
 */
export async function encryptMessage(
  userId: string,
  deviceId: string,
  plaintext: string
): Promise<SignalWireMessage> {
  const session = await keyStorage.getSession(userId, deviceId);
  if (!session) {
    throw new Error(`No session found for ${userId}:${deviceId}`);
  }

  const state = session.state;

  if (!state.sendingChainKey) {
    throw new Error("Sending chain key not initialized");
  }

  // Chain key'den message key turet
  const { messageKey, newChainKey } = deriveMessageKey(state.sendingChainKey);
  state.sendingChainKey = newChainKey;

  // Mesaj header'i
  const header: MessageHeader = {
    ratchetKey: toBase64(state.sendingRatchetKeyPair.publicKey),
    previousChainLength: state.previousSendChainLength,
    messageNumber: state.sendMessageNumber,
  };

  // AES-256-GCM ile sifrele
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await aesGcmEncrypt(messageKey, plaintextBytes, header);

  state.sendMessageNumber++;

  // Session guncelle
  session.state = state;
  session.updatedAt = Date.now();
  await keyStorage.saveSession(session);

  // Ilk mesaj mi kontrol et (PreKey mesaji)
  const preKeyInfo = await keyStorage.getMetadata<PreKeyMessageInfo>(
    `prekey_info:${userId}:${deviceId}`
  );

  if (preKeyInfo) {
    // PreKey bilgisini temizle — sadece ilk mesajda kullanilir
    await keyStorage.setMetadata(`prekey_info:${userId}:${deviceId}`, null);

    return {
      type: SignalMessageType.PreKey,
      header,
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      preKeyInfo,
    };
  }

  return {
    type: SignalMessageType.Whisper,
    header,
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Mesaj cozer (Double Ratchet).
 *
 * Gelen sifreli mesaji mevcut session ile cozer.
 * Header'daki ratchet key degismisse DH ratchet step yapilir.
 *
 * @param senderUserId - Gonderici kullanici ID'si
 * @param senderDeviceId - Gonderici cihaz ID'si
 * @param wireMessage - Wire format sifreli mesaj
 * @returns Cozulmus plaintext (UTF-8)
 */
export async function decryptMessage(
  senderUserId: string,
  senderDeviceId: string,
  wireMessage: SignalWireMessage
): Promise<string> {
  // PreKey mesaji mi?
  if (
    wireMessage.type === SignalMessageType.PreKey &&
    wireMessage.preKeyInfo
  ) {
    // Session yoksa veya yeni X3DH gerekiyorsa
    const existingSession = await keyStorage.getSession(
      senderUserId,
      senderDeviceId
    );

    if (!existingSession) {
      // X3DH ile yeni session kur
      await processPreKeyMessage(
        senderUserId,
        senderDeviceId,
        wireMessage.preKeyInfo
      );
    }
  }

  const session = await keyStorage.getSession(senderUserId, senderDeviceId);
  if (!session) {
    throw new Error(
      `No session found for ${senderUserId}:${senderDeviceId}`
    );
  }

  const state = session.state;
  const header = wireMessage.header;
  const ciphertext = fromBase64(wireMessage.ciphertext);

  // Atlanan mesaj key'lerinde var mi kontrol et
  const skippedIdx = state.skippedMessageKeys.findIndex(
    (sk) =>
      sk.ratchetKey === header.ratchetKey &&
      sk.messageNumber === header.messageNumber
  );

  if (skippedIdx >= 0) {
    const skipped = state.skippedMessageKeys[skippedIdx];
    state.skippedMessageKeys.splice(skippedIdx, 1);

    const plaintext = await aesGcmDecrypt(skipped.messageKey, ciphertext, header);
    const decoded = new TextDecoder().decode(plaintext);

    session.state = state;
    session.updatedAt = Date.now();
    await keyStorage.saveSession(session);

    return decoded;
  }

  // DH ratchet step gerekli mi?
  const headerRatchetKey = fromBase64(header.ratchetKey);
  const currentReceivingKey = state.receivingRatchetKey;

  if (
    !currentReceivingKey ||
    !bytesEqual(headerRatchetKey, currentReceivingKey)
  ) {
    // Yeni DH ratchet key — atlanan mesajlari kaydet
    await skipMessageKeys(state, header.previousChainLength);

    // DH ratchet step
    state.receivingRatchetKey = headerRatchetKey;
    state.previousSendChainLength = state.sendMessageNumber;
    state.sendMessageNumber = 0;
    state.receiveMessageNumber = 0;

    // Yeni receiving chain key
    const dhOutput = x25519.getSharedSecret(
      state.sendingRatchetKeyPair.privateKey,
      headerRatchetKey
    );
    const rkResult = hkdf(
      sha256,
      dhOutput,
      state.rootKey,
      new TextEncoder().encode(HKDF_INFO.ROOT_KEY),
      64
    );
    state.rootKey = rkResult.slice(0, 32);
    state.receivingChainKey = rkResult.slice(32, 64);

    // Yeni sending ratchet key pair
    const newRatchetKeyPair = generateX25519KeyPair();
    const dhOutput2 = x25519.getSharedSecret(
      newRatchetKeyPair.privateKey,
      headerRatchetKey
    );
    const rkResult2 = hkdf(
      sha256,
      dhOutput2,
      state.rootKey,
      new TextEncoder().encode(HKDF_INFO.ROOT_KEY),
      64
    );
    state.rootKey = rkResult2.slice(0, 32);
    state.sendingChainKey = rkResult2.slice(32, 64);
    state.sendingRatchetKeyPair = newRatchetKeyPair;
  }

  // Atlanan mesajlari kaydet
  await skipMessageKeys(state, header.messageNumber);

  if (!state.receivingChainKey) {
    throw new Error("Receiving chain key not initialized");
  }

  // Message key turet
  const { messageKey, newChainKey } = deriveMessageKey(state.receivingChainKey);
  state.receivingChainKey = newChainKey;
  state.receiveMessageNumber++;

  // Decrypt
  const plaintext = await aesGcmDecrypt(messageKey, ciphertext, header);
  const decoded = new TextDecoder().decode(plaintext);

  // Session guncelle
  session.state = state;
  session.updatedAt = Date.now();
  await keyStorage.saveSession(session);

  return decoded;
}

// ──────────────────────────────────
// Session Management
// ──────────────────────────────────

/**
 * Belirli bir kullanici/cihaz icin session var mi kontrol eder.
 */
export async function hasSessionFor(
  userId: string,
  deviceId: string
): Promise<boolean> {
  return keyStorage.hasSession(userId, deviceId);
}

/**
 * Belirli bir kullanici/cihaz icin session siler.
 */
export async function deleteSessionFor(
  userId: string,
  deviceId: string
): Promise<void> {
  await keyStorage.deleteSession(userId, deviceId);
}

/**
 * Bir kullanicinin tum session'larini siler.
 */
export async function deleteAllSessionsFor(userId: string): Promise<void> {
  await keyStorage.deleteAllSessionsForUser(userId);
}

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/**
 * Chain key'den message key turetir.
 *
 * KDF_CK fonksiyonu (Signal spec):
 * - message_key = HMAC(chain_key, 0x01)
 * - new_chain_key = HMAC(chain_key, 0x02)
 *
 * Forward secrecy: Yeni chain key'den eski message key turetilmez.
 * Her mesaj icin farkli bir message key kullanilir.
 */
function deriveMessageKey(chainKey: Uint8Array): {
  messageKey: Uint8Array;
  newChainKey: Uint8Array;
} {
  const messageKey = hmac(sha256, chainKey, new Uint8Array([0x01]));
  const newChainKey = hmac(sha256, chainKey, new Uint8Array([0x02]));
  return { messageKey, newChainKey };
}

/**
 * Atlanan mesaj anahtarlarini kaydeder.
 *
 * Mesajlar sirasiz geldiginde (ornegin #3 once, #1 sonra),
 * eksik mesajlarin key'leri hesaplanip saklanir.
 * Sonra o mesajlar geldiginde saklanan key ile decrypt edilir.
 *
 * DoS koruması: MAX_SKIP (1000) siniri var — bundan fazla
 * mesaj atlanamaz, aksi halde saldirgan memory exhaustion yapabilir.
 */
async function skipMessageKeys(
  state: SessionState,
  until: number
): Promise<void> {
  if (!state.receivingChainKey) return;

  if (until - state.receiveMessageNumber > MAX_SKIP) {
    throw new Error(
      `Too many skipped messages (${until - state.receiveMessageNumber} > ${MAX_SKIP})`
    );
  }

  while (state.receiveMessageNumber < until) {
    const { messageKey, newChainKey } = deriveMessageKey(
      state.receivingChainKey
    );
    state.receivingChainKey = newChainKey;

    state.skippedMessageKeys.push({
      ratchetKey: state.receivingRatchetKey
        ? toBase64(state.receivingRatchetKey)
        : "",
      messageNumber: state.receiveMessageNumber,
      messageKey,
    });

    state.receiveMessageNumber++;
  }
}

/**
 * AES-256-GCM ile sifreler.
 *
 * Web Crypto API kullanir — browser'in native AES-GCM uygulamasi,
 * hardware-accelerated (AES-NI on x86).
 *
 * @param key - 32-byte simetrik anahtar
 * @param plaintext - Sifrelenmemis veri
 * @param associatedData - Ek dogrulama verisi (sifrelenmez ama MAC'e dahil)
 * @returns nonce (12 bytes) + ciphertext + auth tag (16 bytes)
 */
async function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: MessageHeader
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ad = new TextEncoder().encode(JSON.stringify(associatedData));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    cryptoKey,
    plaintext
  );

  // iv (12) + ciphertext + tag (16)
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return result.buffer;
}

/**
 * AES-256-GCM ile cozer.
 *
 * @param key - 32-byte simetrik anahtar
 * @param data - nonce (12 bytes) + ciphertext + auth tag
 * @param associatedData - Ek dogrulama verisi
 * @returns Cozulmus plaintext
 */
async function aesGcmDecrypt(
  key: Uint8Array,
  data: Uint8Array,
  associatedData: MessageHeader
): Promise<ArrayBuffer> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const ad = new TextEncoder().encode(JSON.stringify(associatedData));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    cryptoKey,
    ciphertext
  );
}

/**
 * Birden fazla Uint8Array'i birlestir.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Iki Uint8Array'in esit olup olmadigini kontrol eder.
 * Timing-safe degil (public key karsilastirmasi oldugu icin OK).
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
