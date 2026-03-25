/** Static data constants for the landing page. i18n keys from "landing" namespace. */

// ─── Feature Cards ───

export type FeatureItem = {
  /** i18n key prefix (f1 -> f1_title, f1_desc) */
  translationKey: string;
};

export const FEATURES: FeatureItem[] = [
  { translationKey: "f1" },
  { translationKey: "f2" },
  { translationKey: "f3" },
  { translationKey: "f4" },
  { translationKey: "f5" },
  { translationKey: "f6" },
  { translationKey: "f7" },
  { translationKey: "f8" },
  { translationKey: "f9" },
];

// ─── Comparison Table ───

export type ComparisonRow = {
  key: string;
  /** true = check, false = cross, string = i18n key */
  mqvi: boolean | string;
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
