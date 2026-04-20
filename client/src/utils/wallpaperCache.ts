// Local Blob cache for user wallpaper so the image is not re-downloaded on
// every app start. Keyed by remote URL — when the URL changes, the stale
// entry is replaced.

const DB_NAME = "mqvi_wallpaper";
const STORE = "wallpaper";
const KEY = "current";

type CacheEntry = {
  url: string;
  blob: Blob;
};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function read(): Promise<CacheEntry | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as CacheEntry | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function write(entry: CacheEntry): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clear(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/**
 * Resolves the wallpaper blob URL for the given remote URL.
 * Uses cached blob when the URL matches; otherwise downloads and caches.
 * Returns null on network failure or when url is empty.
 */
export async function resolveWallpaperBlobUrl(url: string | null): Promise<string | null> {
  if (!url) {
    await clear();
    return null;
  }

  const cached = await read();
  if (cached && cached.url === url) {
    return URL.createObjectURL(cached.blob);
  }

  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    await write({ url, blob });
    return URL.createObjectURL(blob);
  } catch {
    return cached ? URL.createObjectURL(cached.blob) : null;
  }
}

export async function clearWallpaperCache(): Promise<void> {
  await clear();
}
