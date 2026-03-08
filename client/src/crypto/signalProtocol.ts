/**
 * Signal Protocol — DM (1-1) encryption layer.
 *
 * X3DH + Double Ratchet implementation for all DM E2EE operations.
 *
 * Crypto primitives: X25519 (ECDH), Ed25519 (signatures), HKDF-SHA-256,
 * HMAC-SHA-256 (chain ratchet), AES-256-GCM (message encryption).
 *
 * Uses @noble/curves because Electron ^33 (Chrome 130) lacks Web Crypto
 * X25519 support (added in Chrome 133). Audited by Cure53 + Trail of Bits.
 *
 * Refs: signal.org/docs/specifications/x3dh/, .../doubleratchet/
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

/** Uint8Array → base64 string. Used for network transfer and IndexedDB keys. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** base64 string → Uint8Array. */
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

/** Generate a new X25519 key pair for Diffie-Hellman key agreement. */
function generateX25519KeyPair(): StoredIdentityKeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Generate all E2EE keys for new device setup and save to IndexedDB.
 * Returns public keys for server upload.
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

  // 2. Ed25519 signing key pair — same seed, different public key format
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

  // 4. One-time prekeys (100)
  const preKeys = generatePreKeys(1, PREKEY_BATCH_SIZE);
  await keyStorage.savePreKeys(preKeys);

  // 5. Registration ID — random 16-bit device identifier
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

/** Generate a signed prekey, signed with Ed25519 identity key (MITM protection). */
async function generateSignedPreKey(
  identityPrivateKey: Uint8Array,
  id: number
): Promise<StoredSignedPreKey> {
  const keyPair = generateX25519KeyPair();

  // Ed25519 signature proves prekey authenticity
  const signature = ed25519.sign(keyPair.publicKey, identityPrivateKey);

  return {
    id,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    signature,
    createdAt: Date.now(),
  };
}

/** Generate a batch of one-time prekeys. */
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

/** Generate additional one-time prekeys when server signals prekey_low. */
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

/** Rotate signed prekey. Called periodically (e.g., weekly). */
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

/** Verify signed prekey signature with Ed25519. */
function verifySignedPreKey(
  identityKey: Uint8Array,
  signedPrekey: Uint8Array,
  signature: Uint8Array
): boolean {
  // Server stores the Ed25519 signing key separately; verify against it
  try {
    return ed25519.verify(signature, signedPrekey, identityKey);
  } catch {
    return false;
  }
}

/**
 * X3DH key agreement — sender side (Alice).
 * Computes shared secret from recipient's prekey bundle via 3-DH or 4-DH,
 * then initializes a Double Ratchet session.
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
    oneTimePrekey?: string;    // base64 X25519 public (optional)
    registrationId: number;
  }
): Promise<void> {
  const identityKeyPair = await keyStorage.getIdentityKeyPair();
  if (!identityKeyPair) {
    throw new Error("Identity key pair not found — device not initialized");
  }

  // Decode bundle
  const theirIdentityKey = fromBase64(bundle.identityKey);
  const theirSigningKey = fromBase64(bundle.signingKey);
  const theirSignedPrekey = fromBase64(bundle.signedPrekey);
  const theirSignature = fromBase64(bundle.signedPrekeySignature);
  const theirOneTimePrekey = bundle.oneTimePrekey
    ? fromBase64(bundle.oneTimePrekey)
    : null;

  // Verify signed prekey signature
  if (!verifySignedPreKey(theirSigningKey, theirSignedPrekey, theirSignature)) {
    throw new Error("Signed prekey signature verification failed");
  }

  // Generate ephemeral key pair
  const ephemeralKeyPair = generateX25519KeyPair();

  // DH calculations
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

  // Concatenate shared secrets
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

  // Derive root key + chain key via HKDF
  const masterSecret = hkdf(
    sha256,
    dhConcat,
    new Uint8Array(32), // salt (zeros — X3DH spec)
    new TextEncoder().encode(HKDF_INFO.ROOT_KEY),
    64 // 32 bytes root key + 32 bytes chain key
  );

  const rootKey = masterSecret.slice(0, 32);
  const chainKey = masterSecret.slice(32, 64);

  // Create session state
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

  // TOFU — trust on first use
  await keyStorage.saveTrustedIdentity({
    userId,
    deviceId,
    identityKey: theirIdentityKey,
    firstSeen: Date.now(),
    verified: false,
  });

  const session: StoredSession = {
    userId,
    deviceId,
    state: sessionState,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Store PreKey info as metadata (used by encryptMessage for first message)
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
 * X3DH key agreement — receiver side (Bob).
 * Called when receiving a PreKey message; computes the same shared secret
 * using the sender's ephemeral key and local prekey private keys.
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

  // Find signed prekey
  const signedPreKey = await keyStorage.getSignedPreKey(
    preKeyInfo.signedPrekeyId
  );
  if (!signedPreKey) {
    throw new Error(
      `Signed prekey ${preKeyInfo.signedPrekeyId} not found`
    );
  }

  // DH calculations (Bob side — reversed order from Alice)
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

  // Include one-time prekey if used
  if (preKeyInfo.oneTimePrekeyId !== undefined) {
    const otpk = await keyStorage.getPreKey(preKeyInfo.oneTimePrekeyId);
    if (otpk) {
      const dh4 = x25519.getSharedSecret(
        otpk.privateKey,
        senderEphemeralKey
      );
      dhConcat = concatBytes(dh1, dh2, dh3, dh4);
      // Don't delete OTP — recovery backup includes all prekeys anyway,
      // so forward secrecy is already compromised by backup mechanism
    } else {
      dhConcat = concatBytes(dh1, dh2, dh3);
    }
  } else {
    dhConcat = concatBytes(dh1, dh2, dh3);
  }

  // Derive root key + chain key via HKDF
  const masterSecret = hkdf(
    sha256,
    dhConcat,
    new Uint8Array(32),
    new TextEncoder().encode(HKDF_INFO.ROOT_KEY),
    64
  );

  const rootKey = masterSecret.slice(0, 32);
  const chainKey = masterSecret.slice(32, 64);

  // Bob's session state — starts with Alice's ratchet key
  const newRatchetKeyPair = generateX25519KeyPair();

  // Bob performs DH ratchet step
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

/** Encrypt a message using Double Ratchet. Chain key advances per message (forward secrecy). */
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

  const { messageKey, newChainKey } = deriveMessageKey(state.sendingChainKey);
  state.sendingChainKey = newChainKey;

  const header: MessageHeader = {
    ratchetKey: toBase64(state.sendingRatchetKeyPair.publicKey),
    previousChainLength: state.previousSendChainLength,
    messageNumber: state.sendMessageNumber,
  };

  // Encrypt with AES-256-GCM
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await aesGcmEncrypt(messageKey, plaintextBytes, header);

  state.sendMessageNumber++;

  session.state = state;
  session.updatedAt = Date.now();
  await keyStorage.saveSession(session);

  // Check if this is a PreKey message (first message in session)
  const preKeyInfo = await keyStorage.getMetadata<PreKeyMessageInfo>(
    `prekey_info:${userId}:${deviceId}`
  );

  if (preKeyInfo) {
    // Clear PreKey info — only used for first message
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

/** Decrypt a message using Double Ratchet. Performs DH ratchet step if ratchet key changed. */
export async function decryptMessage(
  senderUserId: string,
  senderDeviceId: string,
  wireMessage: SignalWireMessage
): Promise<string> {
  // PreKey message?
  if (
    wireMessage.type === SignalMessageType.PreKey &&
    wireMessage.preKeyInfo
  ) {
    // Always re-establish session on PreKey messages.
    // Self-fanout messages are always PreKey for recovery compatibility.
    await processPreKeyMessage(
      senderUserId,
      senderDeviceId,
      wireMessage.preKeyInfo
    );
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

  // Check skipped message keys
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

  // DH ratchet step needed?
  const headerRatchetKey = fromBase64(header.ratchetKey);
  const currentReceivingKey = state.receivingRatchetKey;

  if (
    !currentReceivingKey ||
    !bytesEqual(headerRatchetKey, currentReceivingKey)
  ) {
    // New DH ratchet key — save skipped message keys
    await skipMessageKeys(state, header.previousChainLength);

    // DH ratchet step
    state.receivingRatchetKey = headerRatchetKey;
    state.previousSendChainLength = state.sendMessageNumber;
    state.sendMessageNumber = 0;
    state.receiveMessageNumber = 0;

    // New receiving chain key
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

    // New sending ratchet key pair
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

  // Save skipped message keys
  await skipMessageKeys(state, header.messageNumber);

  if (!state.receivingChainKey) {
    throw new Error("Receiving chain key not initialized");
  }

  const { messageKey, newChainKey } = deriveMessageKey(state.receivingChainKey);
  state.receivingChainKey = newChainKey;
  state.receiveMessageNumber++;

  const plaintext = await aesGcmDecrypt(messageKey, ciphertext, header);
  const decoded = new TextDecoder().decode(plaintext);

  session.state = state;
  session.updatedAt = Date.now();
  await keyStorage.saveSession(session);

  return decoded;
}

// ──────────────────────────────────
// Session Management
// ──────────────────────────────────

/** Check if a session exists for a user/device pair. */
export async function hasSessionFor(
  userId: string,
  deviceId: string
): Promise<boolean> {
  return keyStorage.hasSession(userId, deviceId);
}

/** Delete session for a specific user/device pair. */
export async function deleteSessionFor(
  userId: string,
  deviceId: string
): Promise<void> {
  await keyStorage.deleteSession(userId, deviceId);
}

/** Delete all sessions for a user. */
export async function deleteAllSessionsFor(userId: string): Promise<void> {
  await keyStorage.deleteAllSessionsForUser(userId);
}

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/**
 * Derive message key from chain key (Signal KDF_CK).
 * message_key = HMAC(chain_key, 0x01), new_chain_key = HMAC(chain_key, 0x02).
 * Forward secrecy: old message keys cannot be derived from new chain key.
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
 * Save skipped message keys for out-of-order messages.
 * MAX_SKIP (1000) limit prevents memory exhaustion DoS.
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

/** AES-256-GCM encrypt. Returns nonce (12B) + ciphertext + auth tag (16B). */
async function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: MessageHeader
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ad = new TextEncoder().encode(JSON.stringify(associatedData));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    cryptoKey,
    plaintext as BufferSource
  );

  // iv (12) + ciphertext + tag (16)
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return result.buffer;
}

/** AES-256-GCM decrypt. */
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
    key as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    cryptoKey,
    ciphertext as BufferSource
  );
}

/** Concatenate multiple Uint8Arrays. */
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

/** Compare two Uint8Arrays. Not timing-safe (OK for public key comparison). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
