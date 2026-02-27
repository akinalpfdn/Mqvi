/**
 * themes.ts — 5 tema paleti tanımı + uygulama fonksiyonu.
 *
 * Her tema mevcut CSS variable isimlerini kullanır (--bg-0..5, --t0..3, vb.).
 * applyTheme() çağrıldığında document.documentElement üzerindeki
 * CSS custom property'leri değiştirilerek tüm UI anında güncellenir.
 *
 * Paletler documents/mqvi-palette-explorer.jsx referans alınarak
 * mevcut token yapısına uyarlanmıştır.
 */

export type ThemeId =
  | "ocean"
  | "aurora"
  | "midnight"
  | "ember"
  | "deepTeal"
  | "crispLight"
  | "velvetNight"
  | "nordicFrost"
  | "obsidianRose"
  | "sageTerminal"
  | "slateOcean";

export type ThemePalette = {
  id: ThemeId;
  nameKey: string;
  descKey: string;
  colors: Record<string, string>;
  /** Swatch preview renkleri (tema kartında gösterilir) */
  swatches: [string, string, string];
};

// ────────────────────────────────────────
// Ocean — Mevcut palet (cyan/teal)
// ────────────────────────────────────────
const ocean: ThemePalette = {
  id: "ocean",
  nameKey: "themeOcean",
  descKey: "themeOceanDesc",
  swatches: ["#112830", "#00d0fc", "#5ea5a8"],
  colors: {
    "--bg-0": "#112830",
    "--bg-1": "#182f37",
    "--bg-2": "#1f363e",
    "--bg-3": "#263d46",
    "--bg-4": "#2d444c",
    "--bg-5": "#334a52",
    "--bg-h": "#2a4149",
    "--bg-ub": "#0d2228",
    "--b1": "rgba(255,255,255,0.08)",
    "--b2": "rgba(255,255,255,0.13)",
    "--t0": "#f0f4f6",
    "--t1": "#bcc8ce",
    "--t2": "#8a9aa2",
    "--t3": "#627178",
    "--primary": "#00d0fc",
    "--primary-s": "rgba(0,208,252,0.12)",
    "--primary-m": "rgba(0,208,252,0.24)",
    "--primary-h": "#33dafd",
    "--green": "#6fb07a",
    "--green-s": "rgba(111,176,122,0.10)",
    "--red": "#c46b5e",
    "--red-s": "rgba(196,107,94,0.10)",
    "--yellow": "#e8b040",
    "--teal": "#5ea5a8",
    "--secondary": "#5ea5a8",
    "--secondary-s": "rgba(94,165,168,0.10)",
    "--gradient": "linear-gradient(135deg, #112830 0%, #152e38 40%, #193440 100%)",
  },
};

// ────────────────────────────────────────
// Aurora Borealis — Derin uzay mavisi + kuzey ışıkları yeşili
// ────────────────────────────────────────
const aurora: ThemePalette = {
  id: "aurora",
  nameKey: "themeAurora",
  descKey: "themeAuroraDesc",
  swatches: ["#080c16", "#22d3a0", "#7c6cf0"],
  colors: {
    "--bg-0": "#080c16",
    "--bg-1": "#0f1520",
    "--bg-2": "#172033",
    "--bg-3": "#1c2840",
    "--bg-4": "#21304d",
    "--bg-5": "#273858",
    "--bg-h": "#1c2840",
    "--bg-ub": "#060a12",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#e0eaf0",
    "--t1": "#8eaaba",
    "--t2": "#5e7a94",
    "--t3": "#3d5570",
    "--primary": "#22d3a0",
    "--primary-s": "rgba(34,211,160,0.10)",
    "--primary-m": "rgba(34,211,160,0.22)",
    "--primary-h": "#40e0b8",
    "--green": "#22d3a0",
    "--green-s": "rgba(34,211,160,0.10)",
    "--red": "#e06090",
    "--red-s": "rgba(224,96,144,0.10)",
    "--yellow": "#f0c040",
    "--teal": "#22d3a0",
    "--secondary": "#7c6cf0",
    "--secondary-s": "rgba(124,108,240,0.10)",
    "--gradient": "linear-gradient(135deg, #080c16 0%, #0c1525 40%, #101830 100%)",
  },
};

// ────────────────────────────────────────
// Midnight Ink — Nötr gri + mavi accent (DEFAULT)
// ────────────────────────────────────────
const midnight: ThemePalette = {
  id: "midnight",
  nameKey: "themeMidnight",
  descKey: "themeMidnightDesc",
  swatches: ["#111111", "#3b82f6", "#f59e0b"],
  colors: {
    "--bg-0": "#111111",
    "--bg-1": "#191919",
    "--bg-2": "#222222",
    "--bg-3": "#2a2a2a",
    "--bg-4": "#323232",
    "--bg-5": "#3a3a3a",
    "--bg-h": "#2a2a2a",
    "--bg-ub": "#0f0f0f",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#e8e8e8",
    "--t1": "#a3a3a3",
    "--t2": "#737373",
    "--t3": "#525252",
    "--primary": "#3b82f6",
    "--primary-s": "rgba(59,130,246,0.10)",
    "--primary-m": "rgba(59,130,246,0.22)",
    "--primary-h": "#5b9af7",
    "--green": "#22c55e",
    "--green-s": "rgba(34,197,94,0.10)",
    "--red": "#ef4444",
    "--red-s": "rgba(239,68,68,0.10)",
    "--yellow": "#f59e0b",
    "--teal": "#3b82f6",
    "--secondary": "#3b82f6",
    "--secondary-s": "rgba(59,130,246,0.08)",
    "--gradient": "linear-gradient(135deg, #111111 0%, #161616 40%, #1a1a1a 100%)",
  },
};

// ────────────────────────────────────────
// Warm Ember — Sıcak kahverengi-siyah + turuncu accent
// ────────────────────────────────────────
const ember: ThemePalette = {
  id: "ember",
  nameKey: "themeEmber",
  descKey: "themeEmberDesc",
  swatches: ["#0f0c0a", "#e8863a", "#c07040"],
  colors: {
    "--bg-0": "#0f0c0a",
    "--bg-1": "#1a1513",
    "--bg-2": "#252019",
    "--bg-3": "#302820",
    "--bg-4": "#3a3028",
    "--bg-5": "#443830",
    "--bg-h": "#302820",
    "--bg-ub": "#0c0a08",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#ede6df",
    "--t1": "#b5a899",
    "--t2": "#8a7d6f",
    "--t3": "#5e554b",
    "--primary": "#e8863a",
    "--primary-s": "rgba(232,134,58,0.10)",
    "--primary-m": "rgba(232,134,58,0.22)",
    "--primary-h": "#f09850",
    "--green": "#6fb07a",
    "--green-s": "rgba(111,176,122,0.10)",
    "--red": "#e85d5d",
    "--red-s": "rgba(232,93,93,0.10)",
    "--yellow": "#e8a030",
    "--teal": "#c07040",
    "--secondary": "#c07040",
    "--secondary-s": "rgba(192,112,64,0.10)",
    "--gradient": "linear-gradient(135deg, #0f0c0a 0%, #141110 40%, #1a1512 100%)",
  },
};

// ────────────────────────────────────────
// Deep Teal — İyileştirilmiş kontrast teal
// ────────────────────────────────────────
const deepTeal: ThemePalette = {
  id: "deepTeal",
  nameKey: "themeDeepTeal",
  descKey: "themeDeepTealDesc",
  swatches: ["#091416", "#20dbb0", "#50b4d0"],
  colors: {
    "--bg-0": "#091416",
    "--bg-1": "#0e1e22",
    "--bg-2": "#15292e",
    "--bg-3": "#1b3339",
    "--bg-4": "#223d44",
    "--bg-5": "#28474f",
    "--bg-h": "#1b3339",
    "--bg-ub": "#071012",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#daf0ee",
    "--t1": "#8ec0ba",
    "--t2": "#5e9490",
    "--t3": "#3d6e6a",
    "--primary": "#20dbb0",
    "--primary-s": "rgba(32,219,176,0.10)",
    "--primary-m": "rgba(32,219,176,0.22)",
    "--primary-h": "#40e8c0",
    "--green": "#20dbb0",
    "--green-s": "rgba(32,219,176,0.10)",
    "--red": "#f07068",
    "--red-s": "rgba(240,112,104,0.10)",
    "--yellow": "#e8c040",
    "--teal": "#50b4d0",
    "--secondary": "#50b4d0",
    "--secondary-s": "rgba(80,180,208,0.10)",
    "--gradient": "linear-gradient(135deg, #091416 0%, #0c1a1e 40%, #0e2024 100%)",
  },
};

// ────────────────────────────────────────
// Crisp Light — Aydınlık gündüz modu, temiz ve profesyonel
// ────────────────────────────────────────
const crispLight: ThemePalette = {
  id: "crispLight",
  nameKey: "themeCrispLight",
  descKey: "themeCrispLightDesc",
  swatches: ["#F1F5F9", "#2563EB", "#F59E0B"],
  colors: {
    "--bg-0": "#F1F5F9",
    "--bg-1": "#FFFFFF",
    "--bg-2": "#E2E8F0",
    "--bg-3": "#DBEAFE",
    "--bg-4": "#D1D5DB",
    "--bg-5": "#CBD5E1",
    "--bg-h": "#DBEAFE",
    "--bg-ub": "#E2E8F0",
    "--b1": "rgba(0,0,0,0.08)",
    "--b2": "rgba(0,0,0,0.14)",
    "--t0": "#0F172A",
    "--t1": "#334155",
    "--t2": "#475569",
    "--t3": "#94A3B8",
    "--primary": "#2563EB",
    "--primary-s": "rgba(37,99,235,0.08)",
    "--primary-m": "rgba(37,99,235,0.18)",
    "--primary-h": "#3B82F6",
    "--green": "#16A34A",
    "--green-s": "rgba(22,163,74,0.10)",
    "--red": "#DC2626",
    "--red-s": "rgba(220,38,38,0.10)",
    "--yellow": "#D97706",
    "--teal": "#2563EB",
    "--secondary": "#3B82F6",
    "--secondary-s": "rgba(59,130,246,0.08)",
    "--gradient": "linear-gradient(135deg, #F1F5F9 0%, #F8FAFC 40%, #F1F5F9 100%)",
  },
};

// ────────────────────────────────────────
// Velvet Night — Dracula esintili koyu mor tema
// ────────────────────────────────────────
const velvetNight: ThemePalette = {
  id: "velvetNight",
  nameKey: "themeVelvetNight",
  descKey: "themeVelvetNightDesc",
  swatches: ["#1A1829", "#A855F7", "#EC4899"],
  colors: {
    "--bg-0": "#1A1829",
    "--bg-1": "#221F36",
    "--bg-2": "#2D2942",
    "--bg-3": "#36324E",
    "--bg-4": "#3F3A5A",
    "--bg-5": "#484366",
    "--bg-h": "#36324E",
    "--bg-ub": "#15131F",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#E2DDF0",
    "--t1": "#BDB6D4",
    "--t2": "#A59EBD",
    "--t3": "#787296",
    "--primary": "#A855F7",
    "--primary-s": "rgba(168,85,247,0.10)",
    "--primary-m": "rgba(168,85,247,0.22)",
    "--primary-h": "#B97CF8",
    "--green": "#22c55e",
    "--green-s": "rgba(34,197,94,0.10)",
    "--red": "#EC4899",
    "--red-s": "rgba(236,72,153,0.10)",
    "--yellow": "#F59E0B",
    "--teal": "#A855F7",
    "--secondary": "#C084FC",
    "--secondary-s": "rgba(192,132,252,0.10)",
    "--gradient": "linear-gradient(135deg, #1A1829 0%, #1E1B30 40%, #221F36 100%)",
  },
};

// ────────────────────────────────────────
// Nordic Frost — Nord paletinden ilham alan buzul tema
// ────────────────────────────────────────
const nordicFrost: ThemePalette = {
  id: "nordicFrost",
  nameKey: "themeNordicFrost",
  descKey: "themeNordicFrostDesc",
  swatches: ["#2E3440", "#88C0D0", "#A3BE8C"],
  colors: {
    "--bg-0": "#2E3440",
    "--bg-1": "#3B4252",
    "--bg-2": "#434C5E",
    "--bg-3": "#4C566A",
    "--bg-4": "#556170",
    "--bg-5": "#5E6C78",
    "--bg-h": "#4C566A",
    "--bg-ub": "#2A2F3A",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#ECEFF4",
    "--t1": "#D8DEE9",
    "--t2": "#B0B8C6",
    "--t3": "#99A1B3",
    "--primary": "#88C0D0",
    "--primary-s": "rgba(136,192,208,0.12)",
    "--primary-m": "rgba(136,192,208,0.24)",
    "--primary-h": "#9DD0DE",
    "--green": "#A3BE8C",
    "--green-s": "rgba(163,190,140,0.10)",
    "--red": "#BF616A",
    "--red-s": "rgba(191,97,106,0.10)",
    "--yellow": "#EBCB8B",
    "--teal": "#88C0D0",
    "--secondary": "#81A1C1",
    "--secondary-s": "rgba(129,161,193,0.10)",
    "--gradient": "linear-gradient(135deg, #2E3440 0%, #323845 40%, #363D4A 100%)",
  },
};

// ────────────────────────────────────────
// Obsidian Rose — Lüks koyu tema, altın + gül aksanları
// ────────────────────────────────────────
const obsidianRose: ThemePalette = {
  id: "obsidianRose",
  nameKey: "themeObsidianRose",
  descKey: "themeObsidianRoseDesc",
  swatches: ["#110F14", "#D4A574", "#D46B8C"],
  colors: {
    "--bg-0": "#110F14",
    "--bg-1": "#1A171F",
    "--bg-2": "#23202A",
    "--bg-3": "#2C2834",
    "--bg-4": "#35303F",
    "--bg-5": "#3E384A",
    "--bg-h": "#2C2834",
    "--bg-ub": "#0D0B10",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#EDE9F3",
    "--t1": "#C4BCCE",
    "--t2": "#9B93AB",
    "--t3": "#6B6479",
    "--primary": "#D4A574",
    "--primary-s": "rgba(212,165,116,0.10)",
    "--primary-m": "rgba(212,165,116,0.22)",
    "--primary-h": "#E0B88A",
    "--green": "#22c55e",
    "--green-s": "rgba(34,197,94,0.10)",
    "--red": "#D46B8C",
    "--red-s": "rgba(212,107,140,0.10)",
    "--yellow": "#E8B89D",
    "--teal": "#D4A574",
    "--secondary": "#E8B89D",
    "--secondary-s": "rgba(232,184,157,0.08)",
    "--gradient": "linear-gradient(135deg, #110F14 0%, #151218 40%, #1A171F 100%)",
  },
};

// ────────────────────────────────────────
// Sage Terminal — Yeşil-siyah terminal estetiği, retro-futuristik
// ────────────────────────────────────────
const sageTerminal: ThemePalette = {
  id: "sageTerminal",
  nameKey: "themeSageTerminal",
  descKey: "themeSageTerminalDesc",
  swatches: ["#0A0F0A", "#4ADE80", "#FCD34D"],
  colors: {
    "--bg-0": "#0A0F0A",
    "--bg-1": "#111A11",
    "--bg-2": "#1A261A",
    "--bg-3": "#223022",
    "--bg-4": "#2A3A2A",
    "--bg-5": "#324432",
    "--bg-h": "#223022",
    "--bg-ub": "#080C08",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#D0E8D0",
    "--t1": "#98C098",
    "--t2": "#6E9A6E",
    "--t3": "#4A7040",
    "--primary": "#4ADE80",
    "--primary-s": "rgba(74,222,128,0.10)",
    "--primary-m": "rgba(74,222,128,0.22)",
    "--primary-h": "#6BE898",
    "--green": "#4ADE80",
    "--green-s": "rgba(74,222,128,0.10)",
    "--red": "#F87171",
    "--red-s": "rgba(248,113,113,0.10)",
    "--yellow": "#FCD34D",
    "--teal": "#4ADE80",
    "--secondary": "#86EFAC",
    "--secondary-s": "rgba(134,239,172,0.08)",
    "--gradient": "linear-gradient(135deg, #0A0F0A 0%, #0D140D 40%, #111A11 100%)",
  },
};

// ────────────────────────────────────────
// Slate Ocean — Derin lacivert-gri, profesyonel ve zamansız
// ────────────────────────────────────────
const slateOcean: ThemePalette = {
  id: "slateOcean",
  nameKey: "themeSlateOcean",
  descKey: "themeSlateOceanDesc",
  swatches: ["#0C1220", "#38BDF8", "#FB923C"],
  colors: {
    "--bg-0": "#0C1220",
    "--bg-1": "#131C2E",
    "--bg-2": "#1B2740",
    "--bg-3": "#23314D",
    "--bg-4": "#2B3B5A",
    "--bg-5": "#334567",
    "--bg-h": "#23314D",
    "--bg-ub": "#0A0F1A",
    "--b1": "rgba(255,255,255,0.06)",
    "--b2": "rgba(255,255,255,0.10)",
    "--t0": "#E3E8F0",
    "--t1": "#A8B6C8",
    "--t2": "#7B8FAA",
    "--t3": "#4E6380",
    "--primary": "#38BDF8",
    "--primary-s": "rgba(56,189,248,0.10)",
    "--primary-m": "rgba(56,189,248,0.22)",
    "--primary-h": "#5CCDF9",
    "--green": "#22c55e",
    "--green-s": "rgba(34,197,94,0.10)",
    "--red": "#ef4444",
    "--red-s": "rgba(239,68,68,0.10)",
    "--yellow": "#FB923C",
    "--teal": "#38BDF8",
    "--secondary": "#60A5FA",
    "--secondary-s": "rgba(96,165,250,0.08)",
    "--gradient": "linear-gradient(135deg, #0C1220 0%, #101828 40%, #131C2E 100%)",
  },
};

// ────────────────────────────────────────
// Export
// ────────────────────────────────────────

export const THEMES: Record<ThemeId, ThemePalette> = {
  ocean,
  aurora,
  midnight,
  ember,
  deepTeal,
  crispLight,
  velvetNight,
  nordicFrost,
  obsidianRose,
  sageTerminal,
  slateOcean,
};

export const THEME_ORDER: ThemeId[] = [
  "midnight",
  "aurora",
  "ocean",
  "deepTeal",
  "ember",
  "crispLight",
  "velvetNight",
  "nordicFrost",
  "obsidianRose",
  "sageTerminal",
  "slateOcean",
];

export const DEFAULT_THEME: ThemeId = "midnight";

/**
 * applyTheme — Seçilen temanın CSS variable'larını :root'a uygular.
 *
 * document.documentElement.style.setProperty() kullanarak her variable'ı set eder.
 * Bu sayede globals.css'teki :root fallback değerleri override edilir ve
 * tüm var() referansları anında yeni temayı yansıtır.
 */
export function applyTheme(id: ThemeId): void {
  const theme = THEMES[id];
  if (!theme) return;

  const root = document.documentElement;

  /**
   * Geçiş animasyonu:
   * "theme-transitioning" CSS class'ı tüm * elementlerine
   * background-color/color/border-color transition'ı ekler.
   * 400ms sonra kaldırılır — böylece hover/focus mikro geçişleri etkilenmez.
   */
  root.classList.add("theme-transitioning");

  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(key, value);
  }

  setTimeout(() => {
    root.classList.remove("theme-transitioning");
  }, 400);
}
