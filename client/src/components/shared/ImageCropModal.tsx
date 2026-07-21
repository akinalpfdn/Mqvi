import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import Cropper from "react-easy-crop";
import type { Area } from "react-easy-crop";
import { fitWithin, encodeCanvas } from "../../utils/imageEncoding";

type ImageCropModalProps = {
  /** Data URL of the picked file. */
  image: string;
  aspect: number;
  isCircle?: boolean;
  isBusy?: boolean;
  /**
   * Cap for the produced image. The crop box is in SOURCE pixels, so without this a square crop of
   * a phone photo is emitted at several thousand pixels a side.
   */
  maxWidth: number;
  maxHeight: number;
  onCancel: () => void;
  onApply: (blob: Blob) => void;
};

function ImageCropModal({
  image,
  aspect,
  isCircle = false,
  isBusy = false,
  maxWidth,
  maxHeight,
  onCancel,
  onApply,
}: ImageCropModalProps) {
  const { t } = useTranslation("settings");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  async function handleApply() {
    if (!croppedAreaPixels) return;
    const blob = await getCroppedImage(image, croppedAreaPixels, isCircle, maxWidth, maxHeight);
    if (blob) onApply(blob);
  }

  function handleReset() {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  }

  return (
    <div className="crop-modal-backdrop" onClick={onCancel}>
      <div className="crop-modal" onClick={(e) => e.stopPropagation()}>
        <div className="crop-modal-header">
          <h3 className="crop-modal-title">{t("cropModalTitle")}</h3>
          <button className="crop-modal-close" onClick={onCancel}>
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="crop-modal-canvas">
          <Cropper
            image={image}
            crop={crop}
            zoom={zoom}
            aspect={aspect}
            cropShape={isCircle ? "round" : "rect"}
            showGrid={false}
            onCropChange={setCrop}
            onCropComplete={onCropComplete}
            onZoomChange={setZoom}
          />
        </div>

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

        <div className="crop-modal-footer">
          <button className="crop-modal-reset" onClick={handleReset}>
            {t("cropModalReset")}
          </button>
          <div className="crop-modal-actions">
            <button className="settings-btn settings-btn-secondary" onClick={onCancel}>
              {t("cancel")}
            </button>
            <button className="settings-btn" onClick={handleApply} disabled={isBusy}>
              {isBusy ? t("saving") : t("cropModalApply")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

async function getCroppedImage(
  imageSrc: string,
  pixelCrop: Area,
  isCircle: boolean,
  maxWidth: number,
  maxHeight: number
): Promise<Blob | null> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Canvas matches the crop box's SHAPE, not a square — a 16/9 banner must not be letterboxed —
  // but scaled down to the target. Cropping and downscaling share this one drawImage, so the
  // pixels are resampled once instead of being encoded and re-decoded in between.
  const { width, height } = fitWithin(pixelCrop.width, pixelCrop.height, maxWidth, maxHeight);
  canvas.width = width;
  canvas.height = height;

  if (isCircle) {
    // Ellipse, not arc: a 1:1 crop box can come back a pixel off square.
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2, canvas.height / 2, canvas.width / 2, canvas.height / 2, 0, 0, Math.PI * 2);
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
    canvas.width,
    canvas.height
  );

  // Alpha has to survive when the crop creates it (circular corners) or when the drawn pixels
  // actually carry it. Read the canvas rather than guess from the source type: keying on the shape
  // blackened transparent logos, and keying on "not a JPEG" re-encoded every opaque PNG losslessly.
  return encodeCanvas(canvas, { alpha: isCircle || hasTransparentPixels(ctx, canvas) });
}

/**
 * Whether any drawn pixel is not fully opaque.
 *
 * Every pixel, not a sample: a fixed stride lands on the same columns each row whenever the width is
 * a multiple of it — which the output sizes are — so a narrow transparent band could slip through
 * and get flattened to black. This runs once, on apply, over an image already scaled to its output.
 */
function hasTransparentPixels(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): boolean {
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    // Tainted canvas — cannot inspect, so keep alpha rather than risk flattening it.
    return true;
  }
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
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

export default ImageCropModal;
