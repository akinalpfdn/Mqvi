/**
 * DropZoneOverlay — Tab sürükleme sırasında panelde drop bölgelerini gösteren overlay.
 *
 * CSS class'ları: .drop-zone-overlay, .drop-zone-overlay.active,
 * .drop-zone, .drop-zone.highlight, .drop-zone-left, .drop-zone-right,
 * .drop-zone-top, .drop-zone-bottom, .drop-zone-center
 *
 * Bu component SADECE görseldir — pointer-events: none.
 * Tüm drag event'leri parent PanelView tarafından yakalanır ve
 * activeZone prop'u ile hangi zone'un highlight edileceği belirlenir.
 *
 * Neden overlay kendi event'lerini yakalamıyor?
 * pointer-events: none olan element drag event alamaz.
 * Overlay'ı pointer-events: auto yapmak altındaki content'i engeller.
 * Bu yüzden drag state PanelView'da yönetilir, overlay sadece render eder.
 */

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

type DropZoneOverlayProps = {
  /** Aktif (highlight edilecek) zone — null ise overlay gizli */
  activeZone: DropZone | null;
};

const ZONES: DropZone[] = ["left", "right", "top", "bottom", "center"];

/**
 * Mouse pozisyonundan aktif zone'u hesaplar.
 *
 * Mantık: Her kenardan relative mesafe hesaplanır (0 = kenar, 1 = karşı kenar).
 * En yakın kenar %25 eşik değerinin altındaysa o zone aktif olur.
 * Aksi halde center zone'u aktiftir.
 *
 * Export edilir çünkü PanelView bu fonksiyonu kullanır.
 */
export function calculateZone(
  clientX: number,
  clientY: number,
  rect: DOMRect
): DropZone {
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;

  const distLeft = relX;
  const distRight = 1 - relX;
  const distTop = relY;
  const distBottom = 1 - relY;

  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  const threshold = 0.25;

  if (minDist >= threshold) return "center";
  if (minDist === distLeft) return "left";
  if (minDist === distRight) return "right";
  if (minDist === distTop) return "top";
  return "bottom";
}

function DropZoneOverlay({ activeZone }: DropZoneOverlayProps) {
  if (!activeZone) return null;

  return (
    <div className="drop-zone-overlay active">
      {ZONES.map((zone) => (
        <div
          key={zone}
          className={`drop-zone drop-zone-${zone}${activeZone === zone ? " highlight" : ""}`}
        />
      ))}
    </div>
  );
}

export default DropZoneOverlay;
