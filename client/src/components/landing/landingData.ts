/**
 * landingData — Landing page'de kullanılan statik veri sabitleri.
 *
 * Feature kartları, karşılaştırma tablosu satırları ve roadmap öğeleri
 * burada tanımlanır. Component dosyalarını temiz tutar.
 * Çeviri key'leri i18n "landing" namespace'inden çekilir.
 */

// ─── Feature Cards ───

export type FeatureItem = {
  /** Emoji icon */
  icon: string;
  /** "live" veya "beta" — tag rengi belirler */
  tag: "live" | "beta";
  /** Icon arka plan rengi */
  bgColor: string;
  /** i18n çeviri key prefix'i (f1 → f1_title, f1_desc) */
  translationKey: string;
};

export const FEATURES: FeatureItem[] = [
  { icon: "\uD83D\uDD12", tag: "live", bgColor: "rgba(32,219,176,0.10)", translationKey: "f1" },
  { icon: "\uD83C\uDF99", tag: "live", bgColor: "rgba(80,180,208,0.10)", translationKey: "f2" },
  { icon: "\uD83C\uDFE0", tag: "live", bgColor: "rgba(124,108,240,0.10)", translationKey: "f3" },
  { icon: "\uD83D\uDC64", tag: "live", bgColor: "rgba(240,112,104,0.10)", translationKey: "f4" },
  { icon: "\uD83D\uDDA5", tag: "beta", bgColor: "rgba(32,219,176,0.10)", translationKey: "f5" },
  { icon: "\uD83D\uDEE1", tag: "live", bgColor: "rgba(80,180,208,0.10)", translationKey: "f6" },
  { icon: "\uD83E\uDD1D", tag: "beta", bgColor: "rgba(124,108,240,0.10)", translationKey: "f7" },
  { icon: "\uD83D\uDCD6", tag: "live", bgColor: "rgba(240,112,104,0.10)", translationKey: "f8" },
  { icon: "\u26A1", tag: "live", bgColor: "rgba(32,219,176,0.10)", translationKey: "f9" },
];

// ─── Comparison Table ───

export type ComparisonRow = {
  /** i18n çeviri key'i */
  key: string;
  /** mqvi sütunu: true = ✓, false = ✕, string = çeviri key'i */
  mqvi: boolean | string;
  /** Diğerleri sütunu: true = ✓, false = ✕, string = çeviri key'i */
  other: boolean | string;
};

export const COMPARISON_ROWS: ComparisonRow[] = [
  { key: "cr1", mqvi: true, other: false },
  { key: "cr2", mqvi: true, other: false },
  { key: "cr3", mqvi: true, other: false },
  { key: "cr4", mqvi: true, other: false },
  { key: "cr5", mqvi: true, other: true },
  { key: "cr6", mqvi: true, other: true },
  { key: "cr7", mqvi: true, other: false },
  { key: "cr8", mqvi: "cr8_mqvi", other: "cr8_other" },
];

// ─── Roadmap ───

export type RoadmapItem = {
  /** Emoji icon */
  icon: string;
  /** i18n çeviri key'i */
  key: string;
};

export const ROADMAP_DONE: RoadmapItem[] = [
  { icon: "\uD83D\uDCAC", key: "rd1" },
  { icon: "\uD83C\uDF99", key: "rd2" },
  { icon: "\uD83D\uDD12", key: "rd3" },
  { icon: "\uD83D\uDEE1", key: "rd4" },
  { icon: "\uD83D\uDE00", key: "rd5" },
  { icon: "\u21A9\uFE0F", key: "rd6" },
];

export const ROADMAP_WIP: RoadmapItem[] = [
  { icon: "\uD83D\uDDA5", key: "rw1" },
  { icon: "\uD83E\uDD1D", key: "rw2" },
  { icon: "\uD83C\uDFE0", key: "rw3" },
  { icon: "\uD83C\uDFA8", key: "rw4" },
];

export const ROADMAP_PLANNED: RoadmapItem[] = [
  { icon: "\uD83D\uDCF1", key: "rp1" },
  { icon: "\uD83D\uDD0C", key: "rp2" },
  { icon: "\uD83C\uDF10", key: "rp3" },
  { icon: "\uD83D\uDCC1", key: "rp4" },
];
