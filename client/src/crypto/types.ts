/**
 * E2EE crypto layer internal type definitions.
 * Used only within crypto/ module. API/store types are in types/index.ts.
 * All key material stored as Uint8Array; base64 conversion only for network transfer.
 */

// ──────────────────────────────────
// Key Pairs
// ──────────────────────────────────

/** Identity key pair (X25519). Long-lived device identity, distributed via prekey bundle. */
export type StoredIdentityKeyPair = {
  publicKey: Uint8Array;   // 32 bytes — X25519 public key
  privateKey: Uint8Array;  // 32 bytes — X25519 private key
};

/** Signed prekey — medium-term key, signed by Ed25519 identity key. Rotated periodically. */
export type StoredSignedPreKey = {
  id: number;
  publicKey: Uint8Array;   // 32 bytes — X25519 public key
  privateKey: Uint8Array;  // 32 bytes — X25519 private key
  signature: Uint8Array;   // 64 bytes — Ed25519 signature
  createdAt: number;       // Unix timestamp (ms)
};

/** One-time prekey — single-use ephemeral key for X3DH. Replenished when pool runs low. */
export type StoredPreKey = {
  id: number;
  publicKey: Uint8Array;   // 32 bytes — X25519 public key
  privateKey: Uint8Array;  // 32 bytes — X25519 private key
};

// ──────────────────────────────────
// Ed25519 (Signing)
// ──────────────────────────────────

/**
 * Ed25519 signing key pair.
 * Same 32-byte seed produces both X25519 (ECDH) and Ed25519 (signature)
 * key pairs, but the resulting public keys are different.
 */
export type StoredSigningKeyPair = {
  publicKey: Uint8Array;   // 32 bytes — Ed25519 public key
  privateKey: Uint8Array;  // 32 bytes — seed (private key)
};

// ──────────────────────────────────
// Signal Session State
// ──────────────────────────────────

/**
 * Double Ratchet session state.
 * Three ratchet mechanisms: DH ratchet (new key pair per turn),
 * root chain (DH + root key → new root + chain key),
 * sending/receiving chain (chain key → message key + new chain key).
 */
export type SessionState = {
  /** 32-byte root key — updated on DH ratchet steps */
  rootKey: Uint8Array;

  /** 32-byte sending chain key — null if no messages sent yet */
  sendingChainKey: Uint8Array | null;

  /** 32-byte receiving chain key — null if no messages received yet */
  receivingChainKey: Uint8Array | null;

  /** Our DH ratchet key pair (X25519) */
  sendingRatchetKeyPair: StoredIdentityKeyPair;

  /** Peer's DH ratchet public key — null if not received yet */
  receivingRatchetKey: Uint8Array | null;

  /** Send message counter (current chain) */
  sendMessageNumber: number;

  /** Receive message counter (current chain) */
  receiveMessageNumber: number;

  /** Total messages in previous sending chain */
  previousSendChainLength: number;

  /** Skipped message keys for out-of-order messages. Max 1000 (DoS protection). */
  skippedMessageKeys: SkippedKey[];
};

/** Skipped message key. Composite key: ratchetKey + messageNumber. */
export type SkippedKey = {
  ratchetKey: string;      // base64 encoded X25519 public key
  messageNumber: number;
  messageKey: Uint8Array;  // 32 bytes — AES-256-GCM key
};

/** Signal session stored in IndexedDB. Keyed by userId + deviceId. */
export type StoredSession = {
  userId: string;
  deviceId: string;
  state: SessionState;
  createdAt: number;
  updatedAt: number;
};

// ──────────────────────────────────
// Sender Key (Group Encryption)
// ──────────────────────────────────

/**
 * Sender Key for group/channel encryption.
 * Each sender device creates an outbound key, distributed via 1:1 Signal sessions.
 */
export type StoredSenderKey = {
  channelId: string;
  senderUserId: string;
  senderDeviceId: string;
  /** Distribution ID — session identifier */
  distributionId: string;
  /** 32-byte chain key — advanced via HMAC ratchet per message */
  chainKey: Uint8Array;
  /**
   * 32-byte initial chain key from first distribution.
   * Kept for historical message decryption: since chain ratchet is one-way,
   * old message keys are re-derived from initial key in O(iteration).
   * No forward secrecy (mitigated by key rotation).
   */
  initialChainKey?: Uint8Array;
  /** Ed25519 signing public key */
  publicSigningKey: Uint8Array;
  /** Current iteration count */
  iteration: number;
  createdAt: number;
};

// ──────────────────────────────────
// Trusted Identities
// ──────────────────────────────────

/**
 * Trusted device identity (TOFU — Trust On First Use).
 * Auto-trusted on first encounter; warns on change (MITM protection).
 */
export type TrustedIdentity = {
  userId: string;
  deviceId: string;
  /** X25519 identity public key (32 bytes) */
  identityKey: Uint8Array;
  firstSeen: number;
  /** Manually verified by user (e.g., QR code) */
  verified: boolean;
};

// ──────────────────────────────────
// Message Cache
// ──────────────────────────────────

/**
 * Cached decrypted message in IndexedDB.
 * Enables client-side search since E2EE messages are stored encrypted on server.
 */
export type CachedDecryptedMessage = {
  messageId: string;
  channelId: string;
  /** DM channel ID (null for server messages) */
  dmChannelId: string | null;
  content: string;
  timestamp: number;
};

// ──────────────────────────────────
// Registration & Metadata
// ──────────────────────────────────

/** Device registration metadata. */
export type RegistrationData = {
  /** Signal registration ID — random 16-bit integer */
  registrationId: number;
  deviceId: string;
  userId: string;
  createdAt: number;
};

// ──────────────────────────────────
// Signal Message Types
// ──────────────────────────────────

/** Signal message types. PreKey for first contact (X3DH), Whisper for established sessions. */
export const SignalMessageType = {
  /** Normal Signal message (Double Ratchet) */
  Whisper: 2,
  /** Initial message (X3DH + Double Ratchet) */
  PreKey: 3,
} as const;

export type SignalMessageTypeValue = typeof SignalMessageType[keyof typeof SignalMessageType];

// ──────────────────────────────────
// Message Header
// ──────────────────────────────────

/** Double Ratchet message header. Receiver uses this to perform DH ratchet step. */
export type MessageHeader = {
  /** Sender's current DH ratchet public key (base64) */
  ratchetKey: string;
  /** Total messages in previous sending chain */
  previousChainLength: number;
  /** Message sequence number in current chain */
  messageNumber: number;
};

// ──────────────────────────────────
// Wire Format
// ──────────────────────────────────

/** Encrypted message wire format. Header is unencrypted; body is AES-256-GCM encrypted. */
export type SignalWireMessage = {
  type: SignalMessageTypeValue;
  header: MessageHeader;
  /** AES-256-GCM encrypted content (base64) */
  ciphertext: string;
  /** X3DH info, only present for PreKey messages (type=3) */
  preKeyInfo?: PreKeyMessageInfo;
};

/** X3DH info attached to PreKey messages. Receiver uses this to compute its side. */
export type PreKeyMessageInfo = {
  registrationId: number;
  /** Sender's identity key (base64 X25519 public) */
  identityKey: string;
  /** Sender's ephemeral key (base64 X25519 public) */
  ephemeralKey: string;
  signedPrekeyId: number;
  /** Used one-time prekey ID (if any) */
  oneTimePrekeyId?: number;
};

// ──────────────────────────────────
// Sender Key Wire Format
// ──────────────────────────────────

/** Sender Key distribution message, distributed via 1:1 Signal sessions. */
export type SenderKeyDistributionData = {
  distributionId: string;
  /** 32-byte chain key (base64) */
  chainKey: string;
  /** Ed25519 signing public key (base64) */
  publicSigningKey: string;
  /** Starting iteration */
  iteration: number;
};

/** Message encrypted with Sender Key. */
export type SenderKeyMessage = {
  /** Which sender key was used */
  distributionId: string;
  /** Receiver advances chain key to this point */
  iteration: number;
  /** AES-256-GCM encrypted content (base64) */
  ciphertext: string;
};

// ──────────────────────────────────
// Constants
// ──────────────────────────────────

/** Max skipped message keys (DoS protection) */
export const MAX_SKIP = 1000;

/** Number of one-time prekeys generated per batch */
export const PREKEY_BATCH_SIZE = 100;

/** New batch uploaded when prekey pool drops below this */
export const PREKEY_LOW_THRESHOLD = 10;

/** Sender Key rotation interval (message count) */
export const SENDER_KEY_ROTATION_MESSAGES = 100;

/** Sender Key rotation interval (days) */
export const SENDER_KEY_ROTATION_DAYS = 7;

/** HKDF info strings for protocol versioning */
export const HKDF_INFO = {
  ROOT_KEY: "mqvi-e2ee-rk",
  CHAIN_KEY: "mqvi-e2ee-ck",
  MESSAGE_KEY: "mqvi-e2ee-mk",
  SENDER_KEY: "mqvi-e2ee-sk",
} as const;
