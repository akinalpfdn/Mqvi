/**
 * AvatarUpload — Kullanıcı avatar veya sunucu ikon yükleme bileşeni.
 *
 * CSS class'ları: .avatar-upload, .avatar-upload-overlay
 *
 * Tek bileşen iki kullanım:
 * - isCircle=true: Yuvarlak kullanıcı avatarı
 * - isCircle=false: Köşeli sunucu ikonu
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const ACCEPTED_TYPES = "image/jpeg,image/png,image/gif,image/webp";
const MAX_FILE_SIZE = 8 * 1024 * 1024;

type AvatarUploadProps = {
  currentUrl: string | null;
  previewUrl?: string | null;
  fallbackText: string;
  onUpload: (file: File) => Promise<void>;
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

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      return;
    }

    setIsUploading(true);
    try {
      await onUpload(file);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 24 }}>
      {/* Avatar / İkon + hover overlay */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="avatar-upload"
        disabled={isUploading}
        style={{
          width: 80,
          height: 80,
          borderRadius: isCircle ? "999px" : 12,
          background: "linear-gradient(135deg, var(--amber), #a06840)",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {(previewUrl ?? currentUrl) ? (
          <img
            src={(previewUrl ?? currentUrl)!}
            alt={fallbackText}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span style={{ fontSize: 24, fontWeight: 700, color: "#fff", fontFamily: "var(--f-d)" }}>
            {firstLetter}
          </span>
        )}

        {/* Hover overlay */}
        <div
          className="avatar-upload-overlay"
          style={{ borderRadius: isCircle ? "999px" : 12 }}
        >
          {isUploading ? (
            <div className="spinner" style={{ width: 24, height: 24 }} />
          ) : (
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
            </svg>
          )}
        </div>
      </button>

      {/* Alt bilgi text'leri */}
      <div style={{ textAlign: "center" }}>
        <p style={{ fontSize: 11, color: "var(--t2)" }}>{t("avatarUpload")}</p>
        <p style={{ fontSize: 11, color: "var(--t3)", marginTop: 2 }}>{t("avatarMaxSize")}</p>
      </div>

      {/* Gizli file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileChange}
        style={{ display: "none" }}
      />
    </div>
  );
}

export default AvatarUpload;
