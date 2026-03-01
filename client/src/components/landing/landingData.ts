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
  { icon: "#", tag: "live", bgColor: "rgba(59,130,246,0.10)", translationKey: "f1" },
  { icon: "~", tag: "live", bgColor: "rgba(99,102,241,0.10)", translationKey: "f2" },
  { icon: ">", tag: "live", bgColor: "rgba(59,130,246,0.10)", translationKey: "f3" },
  { icon: "_", tag: "live", bgColor: "rgba(99,102,241,0.10)", translationKey: "f4" },
  { icon: "^", tag: "beta", bgColor: "rgba(59,130,246,0.10)", translationKey: "f5" },
  { icon: "&", tag: "live", bgColor: "rgba(99,102,241,0.10)", translationKey: "f6" },
  { icon: "@", tag: "beta", bgColor: "rgba(59,130,246,0.10)", translationKey: "f7" },
  { icon: "/", tag: "live", bgColor: "rgba(99,102,241,0.10)", translationKey: "f8" },
  { icon: "%", tag: "live", bgColor: "rgba(59,130,246,0.10)", translationKey: "f9" },
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
  { icon: "#", key: "rd1" },
  { icon: "~", key: "rd2" },
  { icon: "&", key: "rd4" },
  { icon: ":", key: "rd5" },
  { icon: "<", key: "rd6" },
  { icon: "^", key: "rd7" },
  { icon: "@", key: "rd8" },
  { icon: ">", key: "rd9" },
  { icon: "*", key: "rd10" },
];

export const ROADMAP_WIP: RoadmapItem[] = [
  { icon: "#", key: "rw1" },
];

export const ROADMAP_PLANNED: RoadmapItem[] = [
  { icon: "+", key: "rp1" },
  { icon: "$", key: "rp2" },
  { icon: "=", key: "rp3" },
  { icon: "/", key: "rp4" },
];
