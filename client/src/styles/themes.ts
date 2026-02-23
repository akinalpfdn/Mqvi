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

export type ThemeId = "ocean" | "aurora" | "midnight" | "ember" | "deepTeal";

export type ThemePalette = {
  id: ThemeId;
  nameKey: string;
  descKey: string;
  colors: Record<string, string>;
  /** Swatch preview renkleri (tema kartında gösterilir) */
  swatches: [string, string, string];
};

/** Tüm CSS variable key'leri */
const themeVars = [
  "--bg-0", "--bg-1", "--bg-2", "--bg-3", "--bg-4", "--bg-5", "--bg-h", "--bg-ub",
  "--b1", "--b2",
  "--t0", "--t1", "--t2", "--t3",
  "--primary", "--primary-s", "--primary-m", "--primary-h",
  "--green", "--green-s",
  "--red", "--red-s",
  "--yellow",
  "--teal",
  "--secondary", "--secondary-s",
  "--gradient",
] as const;

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
// Export
// ────────────────────────────────────────

export const THEMES: Record<ThemeId, ThemePalette> = {
  ocean,
  aurora,
  midnight,
  ember,
  deepTeal,
};

export const THEME_ORDER: ThemeId[] = ["midnight", "aurora", "ocean", "deepTeal", "ember"];

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
