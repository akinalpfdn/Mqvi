/**
 * E2EE crypto layer internal type definitions.
 *
 * Bu tipler sadece crypto/ modulu icinde kullanilir.
 * API ve store tipleri types/index.ts'de tanimlidir.
 *
 * Tum key material Uint8Array olarak saklanir — base64 donusumu
 * sadece network transferinde (API calls) yapilir.
 */

// ──────────────────────────────────
// Key Pairs
// ──────────────────────────────────

/**
 * IndexedDB'de saklanan identity key cifti (X25519).
 *
 * Identity key, cihazin uzun omurlu kriptografik kimligi.
 * Bir kez olusturulur, cihaz silinene kadar degismez.
 * publicKey baska kullanicilara dagitilir (prekey bundle icinde).
 */
export type StoredIdentityKeyPair = {
  publicKey: Uint8Array;   // 32 bytes — X25519 public key
  privateKey: Uint8Array;  // 32 bytes — X25519 private key
};

/**
 * IndexedDB'de saklanan signed prekey.
 *
 * Signed prekey, orta vadeli anahtar (~1 hafta/ay).
 * Identity key'in Ed25519 karsiligi ile imzalanir.
 * Prekey bundle icinde diger kullanicilara sunulur.
 * Periyodik olarak rotate edilir (yeni olusturulur, eski silinir).
 */
export type StoredSignedPreKey = {
  id: number;
  publicKey: Uint8Array;   // 32 bytes — X25519 public key
  privateKey: Uint8Array;  // 32 bytes — X25519 private key
  signature: Uint8Array;   // 64 bytes — Ed25519 signature
  createdAt: number;       // Unix timestamp (ms)
};

/**
 * IndexedDB'de saklanan one-time prekey.
 *
 * Tek kullanimlik ephemeral prekey — X3DH'da kullanilir ve tuketilir.
 * Havuz azaldiginda (< 10) sunucu prekey_low event'i gonderir,
 * client yeni batch yukler.
 */
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
 *
 * X25519 (ECDH) ve Ed25519 (signature) farkli anahtar formatlari kullanir.
 * Identity key olarak X25519 kullanilir (DH icin), ancak signed prekey'i
 * imzalamak icin Ed25519 gerekir. Ayni seed'den her iki format da turetilir.
 *
 * @noble/curves kutuphanesi bu donusumu saglar:
 * - ed25519.getPublicKey(seed) → Ed25519 public key
 * - ed25519.sign(message, seed) → Ed25519 signature
 * - x25519.getPublicKey(seed) → X25519 public key
 *
 * Onemli: Ayni 32-byte seed hem X25519 hem Ed25519 icin kullanilir,
 * ama urettikleri public key'ler FARKLIDIR.
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
 *
 * Signal Protocol'un cekirdegi — her mesaj degisiminde
 * simetrik anahtarlar ileri dogru hareket eder (forward secrecy).
 *
 * Uc ratchet mekanizmasi:
 * 1. DH Ratchet: Her tur degisiminde yeni DH key pair uretilir
 * 2. Root Chain: DH output + root key → yeni root key + chain key
 * 3. Sending/Receiving Chain: chain key → message key + yeni chain key
 */
export type SessionState = {
  /** 32-byte root key — DH ratchet step'lerinde guncellenir */
  rootKey: Uint8Array;

  /** 32-byte sending chain key — null ise henuz gonderi yapilmamis */
  sendingChainKey: Uint8Array | null;

  /** 32-byte receiving chain key — null ise henuz mesaj alinmamis */
  receivingChainKey: Uint8Array | null;

  /** Bizim DH ratchet key pair'imiz (X25519) */
  sendingRatchetKeyPair: StoredIdentityKeyPair;

  /** Karsi tarafin DH ratchet public key'i — null ise henuz alinmamis */
  receivingRatchetKey: Uint8Array | null;

  /** Gonderilen mesaj sayaci (mevcut chain'de) */
  sendMessageNumber: number;

  /** Alinan mesaj sayaci (mevcut chain'de) */
  receiveMessageNumber: number;

  /** Onceki sending chain'deki toplam mesaj sayisi */
  previousSendChainLength: number;

  /**
   * Atlanan mesaj anahtarlari — sirasiz gelen mesajlar icin.
   *
   * Ornek: Mesaj #3 once gelirse, #1 ve #2 icin message key'ler
   * burada saklanir. Sonra #1 ve #2 geldiginde bu key'lerle decrypt edilir.
   * Guvenlik: Max 1000 atlanan anahtar saklanir (DoS koruması).
   */
  skippedMessageKeys: SkippedKey[];
};

/**
 * Atlanan mesaj anahtari (out-of-order mesajlar icin).
 * ratchetKey + messageNumber bileşik anahtar olarak kullanılır.
 */
export type SkippedKey = {
  ratchetKey: string;      // base64 encoded X25519 public key
  messageNumber: number;
  messageKey: Uint8Array;  // 32 bytes — AES-256-GCM key
};

/**
 * IndexedDB'de saklanan Signal session.
 * userId + deviceId birlesik anahtar olusturur.
 */
export type StoredSession = {
  /** Karsi tarafin user ID'si */
  userId: string;
  /** Karsi tarafin device ID'si */
  deviceId: string;
  /** Double Ratchet state */
  state: SessionState;
  /** Olusturulma zamani (ms) */
  createdAt: number;
  /** Son guncelleme zamani (ms) */
  updatedAt: number;
};

// ──────────────────────────────────
// Sender Key (Group Encryption)
// ──────────────────────────────────

/**
 * IndexedDB'de saklanan Sender Key.
 *
 * Sender Key, grup/kanal sifreleme icin kullanilir.
 * Her gonderici cihaz, kanal icin bir outbound sender key olusturur.
 * Bu key, kanal uyelerine Signal 1:1 session'lari uzerinden dagitilir.
 *
 * chainKey: Simetrik anahtar — her mesajda HMAC ile ilerletilir
 * publicSigningKey: Mesaj kimlik dogrulamasi icin
 * iteration: Kac kez ilerletildigini takip eder
 */
export type StoredSenderKey = {
  /** Kanal ID'si */
  channelId: string;
  /** Gonderici kullanici ID'si */
  senderUserId: string;
  /** Gonderici cihaz ID'si */
  senderDeviceId: string;
  /** Distribution ID — oturum tanimlayicisi */
  distributionId: string;
  /** 32-byte chain key — HMAC ratchet ile ilerletilir */
  chainKey: Uint8Array;
  /**
   * 32-byte baslangic chain key — ilk distribution'daki orijinal key.
   *
   * Chain key ratchet tek yonludur (HMAC ile ileri gider, geri gelemez).
   * Tarihsel mesajlari decrypt edebilmek icin (fetchMessages ile gelen
   * eski iterasyonlar), orijinal chain key saklanir ve gerektiginde
   * bastan itibaren ileri tureterek eski message key'ler elde edilir.
   *
   * Bu, Signal'in "message key cache" yaklasiminin daha verimli versiyonudur:
   * N adet message key saklamak yerine, tek bir initial key'den herhangi
   * bir iterasyonun key'i O(iteration) ile turetilir.
   *
   * Guvenlik: initialChainKey ile TUM gecmis message key'ler turetilebildigi
   * icin forward secrecy yoktur. Ancak Sender Key protokolunde forward secrecy
   * zaten sinirlidir — gercek forward secrecy icin key rotation kullanilir.
   */
  initialChainKey?: Uint8Array;
  /** 32-byte signing public key (Ed25519) */
  publicSigningKey: Uint8Array;
  /** Mevcut iterasyon sayisi */
  iteration: number;
  /** Olusturulma zamani (ms) */
  createdAt: number;
};

// ──────────────────────────────────
// Trusted Identities
// ──────────────────────────────────

/**
 * Guvenilen cihaz kimligi.
 *
 * TOFU (Trust On First Use): Bir kullanicinin cihazinin identity key'i
 * ilk goruldugunde otomatik guvenilir. Sonradan degisirse
 * "identity key changed" uyarisi gosterilir (MITM koruması).
 */
export type TrustedIdentity = {
  /** Kullanici ID'si */
  userId: string;
  /** Cihaz ID'si */
  deviceId: string;
  /** 32 bytes — X25519 identity public key */
  identityKey: Uint8Array;
  /** Ilk gorulme zamani (ms) */
  firstSeen: number;
  /** Kullanici tarafindan dogrulanmis mi (QR code vb.) */
  verified: boolean;
};

// ──────────────────────────────────
// Message Cache
// ──────────────────────────────────

/**
 * Decrypt edilmis mesajin IndexedDB cache'i.
 *
 * E2EE mesajlar sunucuda sifreli saklanir, dolayisiyla
 * sunucu tarafli arama calismaz. Decrypt edilen mesajlar
 * client-side IndexedDB'ye yazilir ve lokal arama yapilir.
 */
export type CachedDecryptedMessage = {
  /** Mesaj ID'si (sunucudaki ID) */
  messageId: string;
  /** Kanal ID'si (index icin) */
  channelId: string;
  /** DM kanal ID'si (DM mesajlari icin, null ise server mesaji) */
  dmChannelId: string | null;
  /** Decrypt edilmis icerik */
  content: string;
  /** Mesaj zamani (ms) */
  timestamp: number;
};

// ──────────────────────────────────
// Registration & Metadata
// ──────────────────────────────────

/**
 * Cihaz kayit metadata'si.
 * IndexedDB metadata store'unda saklanir.
 */
export type RegistrationData = {
  /** Signal registration ID — rastgele 16-bit tamsayi */
  registrationId: number;
  /** Bu cihazin benzersiz ID'si */
  deviceId: string;
  /** Kullanici ID'si */
  userId: string;
  /** Kayit zamani (ms) */
  createdAt: number;
};

// ──────────────────────────────────
// Signal Message Types
// ──────────────────────────────────

/**
 * Signal mesaj tipleri.
 * PreKey mesaji ilk iletisimde (X3DH) kullanilir.
 * Whisper mesaji kurulmus session'larda kullanilir.
 */
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

/**
 * Double Ratchet mesaj header'i.
 *
 * Her sifreli mesajin basinda yer alir.
 * Alici bu bilgiyle DH ratchet step yapar ve dogru chain key'i bulur.
 */
export type MessageHeader = {
  /** Gondericinin mevcut DH ratchet public key'i (base64) */
  ratchetKey: string;
  /** Onceki sending chain'deki toplam mesaj sayisi */
  previousChainLength: number;
  /** Bu mesajin chain icindeki sirasi */
  messageNumber: number;
};

// ──────────────────────────────────
// Wire Format
// ──────────────────────────────────

/**
 * Sifreli mesaj wire format'i.
 *
 * Network uzerinden gonderilen/alinan mesaj yapisi.
 * Header sifrelenmez (alicinin session'i ilerletmesi icin gerekli).
 * Body AES-256-GCM ile sifrelenir.
 */
export type SignalWireMessage = {
  /** Mesaj tipi (2=Whisper, 3=PreKey) */
  type: SignalMessageTypeValue;
  /** Sifrelenmemis header */
  header: MessageHeader;
  /** AES-256-GCM ile sifreli icerik (base64) */
  ciphertext: string;
  /** PreKey mesaji icin ek bilgiler (sadece type=3'te) */
  preKeyInfo?: PreKeyMessageInfo;
};

/**
 * PreKey mesajina eklenen X3DH bilgileri.
 * Alici bu bilgilerle X3DH'nin kendi tarafini hesaplar.
 */
export type PreKeyMessageInfo = {
  /** Gondericinin registration ID'si */
  registrationId: number;
  /** Gondericinin identity key'i (base64 X25519 public) */
  identityKey: string;
  /** Gondericinin ephemeral key'i (base64 X25519 public) */
  ephemeralKey: string;
  /** Kullnilan signed prekey ID'si */
  signedPrekeyId: number;
  /** Kullanilan one-time prekey ID'si (varsa) */
  oneTimePrekeyId?: number;
};

// ──────────────────────────────────
// Sender Key Wire Format
// ──────────────────────────────────

/**
 * Sender Key distribution message.
 *
 * Grup sifrelemede, gondericinin sender key'ini
 * kanal uyelerine dagitmak icin kullanilir.
 * Signal 1:1 session'lari uzerinden sifrelenerek gonderilir.
 */
export type SenderKeyDistributionData = {
  /** Benzersiz distribution ID */
  distributionId: string;
  /** 32-byte chain key (base64) */
  chainKey: string;
  /** 32-byte Ed25519 signing public key (base64) */
  publicSigningKey: string;
  /** Baslangic iterasyonu */
  iteration: number;
};

/**
 * Sender Key ile sifreli mesaj.
 */
export type SenderKeyMessage = {
  /** Distribution ID — hangi sender key ile sifrelandigini belirtir */
  distributionId: string;
  /** Mesaj iterasyonu — alici chain key'i bu noktaya ilerletir */
  iteration: number;
  /** AES-256-GCM ile sifreli icerik (base64) */
  ciphertext: string;
};

// ──────────────────────────────────
// Constants
// ──────────────────────────────────

/** Maksimum atlanan mesaj anahtari sayisi (DoS koruması) */
export const MAX_SKIP = 1000;

/** Bir batch'te uretilen one-time prekey sayisi */
export const PREKEY_BATCH_SIZE = 100;

/** Prekey havuzu bu sayinin altina dustugunde yeni batch yuklenir */
export const PREKEY_LOW_THRESHOLD = 10;

/** Sender Key rotasyon intervali (mesaj sayisi) */
export const SENDER_KEY_ROTATION_MESSAGES = 100;

/** Sender Key rotasyon intervali (gun) */
export const SENDER_KEY_ROTATION_DAYS = 7;

/** HKDF info string'leri — protokol versiyonlama icin */
export const HKDF_INFO = {
  ROOT_KEY: "mqvi-e2ee-rk",
  CHAIN_KEY: "mqvi-e2ee-ck",
  MESSAGE_KEY: "mqvi-e2ee-mk",
  SENDER_KEY: "mqvi-e2ee-sk",
} as const;
