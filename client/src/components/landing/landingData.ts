/**
 * landingData — Landing page'de kullanılan statik veri sabitleri.
 *
 * Feature kartları, karşılaştırma tablosu satırları ve roadmap öğeleri
 * burada tanımlanır. Component dosyalarını temiz tutar.
 * Çeviri key'leri i18n "landing" namespace'inden çekilir.
 */

// ─── Feature Cards ───

export type FeatureItem = {
  /** "live" veya "beta" — tag rengi belirler */
  tag: "live" | "beta";
  /** i18n çeviri key prefix'i (f1 → f1_title, f1_desc) */
  translationKey: string;
};

export const FEATURES: FeatureItem[] = [
  { tag: "live", translationKey: "f1" },
  { tag: "live", translationKey: "f2" },
  { tag: "live", translationKey: "f3" },
  { tag: "live", translationKey: "f4" },
  { tag: "beta", translationKey: "f5" },
  { tag: "live", translationKey: "f6" },
  { tag: "beta", translationKey: "f7" },
  { tag: "live", translationKey: "f8" },
  { tag: "live", translationKey: "f9" },
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
  /** i18n çeviri key'i */
  key: string;
};

export const ROADMAP_DONE: RoadmapItem[] = [
  { key: "rd1" },
  { key: "rd2" },
  { key: "rd4" },
  { key: "rd5" },
  { key: "rd6" },
  { key: "rd7" },
  { key: "rd8" },
  { key: "rd9" },
  { key: "rd10" },
];

export const ROADMAP_WIP: RoadmapItem[] = [
  { key: "rw1" },
];

export const ROADMAP_PLANNED: RoadmapItem[] = [
  { key: "rp1" },
  { key: "rp2" },
  { key: "rp3" },
  { key: "rp4" },
];
