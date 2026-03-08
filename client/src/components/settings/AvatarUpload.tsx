/** AvatarUpload — Avatar/icon upload with crop modal (circle or square). */

import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Cropper from "react-easy-crop";
import type { Area } from "react-easy-crop";
import { resolveAssetUrl } from "../../utils/constants";

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

  // Crop modal state
  const [cropImage, setCropImage] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  const firstLetter = fallbackText.charAt(0).toUpperCase();

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) return;

    // Read as data URL and open crop modal
    const reader = new FileReader();
    reader.onload = () => {
      setCropImage(reader.result as string);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
    };
    reader.readAsDataURL(file);

    // Reset input so the same file can be re-selected
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  async function handleApply() {
    if (!cropImage || !croppedAreaPixels) return;

    setIsUploading(true);
    try {
      const croppedBlob = await getCroppedImage(cropImage, croppedAreaPixels, isCircle);
      if (!croppedBlob) return;

      const file = new File([croppedBlob], "avatar.png", { type: "image/png" });
      await onUpload(file);
    } finally {
      setIsUploading(false);
      setCropImage(null);
    }
  }

  function handleCancel() {
    setCropImage(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  }

  function handleReset() {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
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

      {/* ── Crop Modal ── */}
      {cropImage && (
        <div className="crop-modal-backdrop" onClick={handleCancel}>
          <div className="crop-modal" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="crop-modal-header">
              <h3 className="crop-modal-title">{t("cropModalTitle")}</h3>
              <button className="crop-modal-close" onClick={handleCancel}>
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Crop area */}
            <div className="crop-modal-canvas">
              <Cropper
                image={cropImage}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape={isCircle ? "round" : "rect"}
                showGrid={false}
                onCropChange={setCrop}
                onCropComplete={onCropComplete}
                onZoomChange={setZoom}
              />
            </div>

            {/* Controls */}
            <div className="crop-modal-controls">
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
              </svg>
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="crop-modal-slider"
              />
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
              </svg>
            </div>

            {/* Footer */}
            <div className="crop-modal-footer">
              <button className="crop-modal-reset" onClick={handleReset}>
                {t("cropModalReset")}
              </button>
              <div className="crop-modal-actions">
                <button className="settings-btn settings-btn-secondary" onClick={handleCancel}>
                  {t("cancel")}
                </button>
                <button
                  className="settings-btn"
                  onClick={handleApply}
                  disabled={isUploading}
                >
                  {isUploading ? t("saving") : t("cropModalApply")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Produce cropped image blob on canvas. Applies circular clip mask when isCircle=true. */
async function getCroppedImage(
  imageSrc: string,
  pixelCrop: Area,
  isCircle: boolean
): Promise<Blob | null> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const size = Math.max(pixelCrop.width, pixelCrop.height);
  canvas.width = size;
  canvas.height = size;

  if (isCircle) {
    // Circular clip mask
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  }

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    size,
    size
  );

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png", 1);
  });
}

function createImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img));
    img.addEventListener("error", (e) => reject(e));
    img.crossOrigin = "anonymous";
    img.src = url;
  });
}

export default AvatarUpload;
