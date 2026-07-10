/**
 * Fixed discovery categories — must match backend models.ValidServerCategories.
 * Order defines the display order in the settings picker and discovery tabs.
 * Display names are resolved via i18n (settings namespace: `category_<key>`).
 */
export const SERVER_CATEGORIES = [
  "gaming",
  "music",
  "entertainment",
  "science_tech",
  "education",
  "community",
  "anime_manga",
] as const;

export type ServerCategory = (typeof SERVER_CATEGORIES)[number];

/** i18n key (settings namespace) for a category's display name. */
export function categoryLabelKey(category: string): string {
  return `category_${category}`;
}
