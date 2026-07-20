/** AvatarUpload — Avatar/icon upload with crop modal (circle or square). */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ImageCropModal from "../shared/ImageCropModal";
import { resolveAssetUrl, MAX_AVATAR_UPLOAD_SIZE } from "../../utils/constants";
import { useFileRejectionNotice } from "../../hooks/useFileRejectionNotice";

const ACCEPTED_TYPES = "image/jpeg,image/png,image/gif,image/webp";

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
  const [cropImage, setCropImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const notifyRejected = useFileRejectionNotice();

  const firstLetter = fallbackText.charAt(0).toUpperCase();

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_UPLOAD_SIZE) {
      notifyRejected([file], { reason: "size", maxBytes: MAX_AVATAR_UPLOAD_SIZE });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setCropImage(reader.result as string);
    reader.readAsDataURL(file);

    // Reset input so the same file can be re-selected
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleApply(blob: Blob) {
    setIsUploading(true);
    try {
      await onUpload(new File([blob], "avatar.png", { type: "image/png" }));
    } finally {
      setIsUploading(false);
      setCropImage(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 24 }}>
      {/* Avatar / Icon + hover overlay */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="avatar-upload"
        disabled={isUploading}
        style={{
          width: 80,
          height: 80,
          borderRadius: isCircle ? "999px" : 12,
          background: "linear-gradient(135deg, var(--primary), var(--secondary))",
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
            src={previewUrl ?? resolveAssetUrl(currentUrl!)}
            alt={fallbackText}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span style={{ fontSize: 24, fontWeight: 700, color: "#fff" }}>
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

      {/* Info text */}
      <div style={{ textAlign: "center" }}>
        <p style={{ fontSize: 13, color: "var(--t2)" }}>{t("avatarUpload")}</p>
        <p style={{ fontSize: 13, color: "var(--t3)", marginTop: 2 }}>{t("avatarMaxSize")}</p>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileChange}
        style={{ display: "none" }}
      />

      {cropImage && (
        <ImageCropModal
          image={cropImage}
          aspect={1}
          isCircle={isCircle}
          isBusy={isUploading}
          onCancel={() => setCropImage(null)}
          onApply={handleApply}
        />
      )}
    </div>
  );
}

export default AvatarUpload;
