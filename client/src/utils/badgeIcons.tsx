/**
 * Built-in badge icon set — 16 SVG icons for badge creation.
 * Each icon has a unique key used as the `icon` field when icon_type is "builtin".
 */

import type { ReactElement } from "react";

type BadgeIconDef = {
  key: string;
  label: string;
  svg: ReactElement;
};

const s = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const BADGE_ICONS: BadgeIconDef[] = [
  {
    key: "star",
    label: "Star",
    svg: <svg {...s}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>,
  },
  {
    key: "shield",
    label: "Shield",
    svg: <svg {...s}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>,
  },
  {
    key: "crown",
    label: "Crown",
    svg: <svg {...s}><path d="M2 4l3 12h14l3-12-5 4-5-4-5 4-3-4z" /><path d="M5 16h14v2H5z" /></svg>,
  },
  {
    key: "trophy",
    label: "Trophy",
    svg: <svg {...s}><path d="M6 9H4a2 2 0 01-2-2V4h4" /><path d="M18 9h2a2 2 0 002-2V4h-4" /><path d="M4 22h16" /><path d="M10 22V10" /><path d="M14 22V10" /><rect x="6" y="2" width="12" height="8" rx="2" /></svg>,
  },
  {
    key: "diamond",
    label: "Diamond",
    svg: <svg {...s}><path d="M2.7 10.3a2.41 2.41 0 000 3.41l7.59 7.59a2.41 2.41 0 003.41 0l7.59-7.59a2.41 2.41 0 000-3.41L13.7 2.71a2.41 2.41 0 00-3.41 0z" /></svg>,
  },
  {
    key: "flame",
    label: "Flame",
    svg: <svg {...s}><path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z" /></svg>,
  },
  {
    key: "bolt",
    label: "Bolt",
    svg: <svg {...s}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>,
  },
  {
    key: "heart",
    label: "Heart",
    svg: <svg {...s}><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>,
  },
  {
    key: "eye",
    label: "Eye",
    svg: <svg {...s}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>,
  },
  {
    key: "music",
    label: "Music",
    svg: <svg {...s}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>,
  },
  {
    key: "code",
    label: "Code",
    svg: <svg {...s}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>,
  },
  {
    key: "bug",
    label: "Bug",
    svg: <svg {...s}><rect x="8" y="6" width="8" height="14" rx="4" /><path d="M19 12h2" /><path d="M3 12h2" /><path d="M19 8h2" /><path d="M3 8h2" /><path d="M19 16h2" /><path d="M3 16h2" /><path d="M9 2l1.5 2" /><path d="M13.5 4L15 2" /></svg>,
  },
  {
    key: "palette",
    label: "Palette",
    svg: <svg {...s}><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" /><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" /><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" /><circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 011.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" /></svg>,
  },
  {
    key: "globe",
    label: "Globe",
    svg: <svg {...s}><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" /></svg>,
  },
  {
    key: "rocket",
    label: "Rocket",
    svg: <svg {...s}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg>,
  },
  {
    key: "skull",
    label: "Skull",
    svg: <svg {...s}><circle cx="9" cy="12" r="1" fill="currentColor" /><circle cx="15" cy="12" r="1" fill="currentColor" /><path d="M8 20v2h8v-2" /><path d="M12.5 17-.5-1h-1l-.5 1" /><path d="M16 20a2 2 0 001.56-3.25 8 8 0 10-11.12 0A2 2 0 008 20" /></svg>,
  },
];

/** Find a built-in icon definition by its key. */
export function getBadgeIcon(key: string): BadgeIconDef | undefined {
  return BADGE_ICONS.find((i) => i.key === key);
}
