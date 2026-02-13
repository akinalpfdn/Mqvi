/**
 * AvatarUpload — Kullanıcı avatar veya sunucu ikon yükleme bileşeni.
 *
 * Tek bileşen iki kullanım:
 * - isCircle=true (varsayılan): Yuvarlak kullanıcı avatarı
 * - isCircle=false: Köşeli sunucu ikonu
 *
 * Davranış:
 * 1. Mevcut avatar/ikon varsa göster, yoksa fallbackText'in ilk harfi
 * 2. Hover'da kamera overlay'i belirir → tıklayınca file picker açılır
 * 3. Dosya seçilince onUpload callback çağrılır (parent component upload yapar)
 * 4. Upload sırasında loading spinner gösterilir
 *
 * previewUrl prop'u:
 * Parent component dosya seçimini defer edip local preview gösterebilir.
 * previewUrl verildiğinde currentUrl yerine bu gösterilir.
 * Bu sayede "Save" butonuna basılana kadar sunucuya yükleme yapılmaz.
 *
 * Dosya validasyonu:
 * - Client-side MIME type kontrolü (sadece resim)
 * - 8MB boyut limiti client-side'da da kontrol edilir (backend'e boşa istek atmasın)
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Avatar yükleme için kabul edilen resim MIME type'ları */
const ACCEPTED_TYPES = "image/jpeg,image/png,image/gif,image/webp";

/** Maksimum dosya boyutu (8MB) — backend ile aynı limit */
const MAX_FILE_SIZE = 8 * 1024 * 1024;

type AvatarUploadProps = {
  /** Mevcut avatar/ikon URL'i — null ise fallback gösterilir */
  currentUrl: string | null;
  /**
   * Local preview URL — dosya seçildi ama henüz yüklenmedi durumunda gösterilir.
   * URL.createObjectURL() ile oluşturulur. Verildiğinde currentUrl'den önceliklidir.
   */
  previewUrl?: string | null;
  /** Fallback text — avatarın içinde gösterilecek (genellikle ilk harf) */
  fallbackText: string;
  /** Dosya seçildiğinde çağrılır — parent component upload işlemini yapar */
  onUpload: (file: File) => Promise<void>;
  /** true: yuvarlak (kullanıcı avatar), false: köşeli (sunucu ikon) */
  isCircle?: boolean;
};

function AvatarUpload({
  currentUrl,
  previewUrl,
  fallbackText,
  onUpload,
  isCircle = true,
}: AvatarUploadProps) {
  const { t } = useTranslation("settings");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const firstLetter = fallbackText.charAt(0).toUpperCase();
  const shapeClass = isCircle ? "rounded-full" : "rounded-xl";

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Client-side boyut kontrolü — backend'e boşa istek göndermesini önler
    if (file.size > MAX_FILE_SIZE) {
      return;
    }

    setIsUploading(true);
    try {
      await onUpload(file);
    } finally {
      setIsUploading(false);
      // Input'u sıfırla — aynı dosyayı tekrar seçebilmek için
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Avatar / İkon görünümü + hover overlay */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className={`group relative flex h-20 w-20 items-center justify-center overflow-hidden ${shapeClass} bg-brand transition-opacity`}
        disabled={isUploading}
      >
        {/* Mevcut avatar resmi veya fallback harf */}
        {/* previewUrl öncelikli — henüz kaydedilmemiş yerel seçimi gösterir */}
        {(previewUrl ?? currentUrl) ? (
          <img
            src={(previewUrl ?? currentUrl)!}
            alt={fallbackText}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-2xl font-bold text-white">{firstLetter}</span>
        )}

        {/* Hover overlay — kamera ikonu ve "yükleme" text'i */}
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100 ${shapeClass}`}
        >
          {isUploading ? (
            // Loading spinner — SVG dönen animasyon
            <svg
              className="h-6 w-6 animate-spin text-white"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          ) : (
            // Kamera ikonu
            <svg
              className="h-6 w-6 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z"
              />
            </svg>
          )}
        </div>
      </button>

      {/* Alt bilgi text'leri */}
      <div className="text-center">
        <p className="text-xs text-text-muted">{t("avatarUpload")}</p>
        <p className="mt-0.5 text-xs text-text-muted">{t("avatarMaxSize")}</p>
      </div>

      {/* Gizli file input — tarayıcının native dosya seçiciyi açması için */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}

export default AvatarUpload;
