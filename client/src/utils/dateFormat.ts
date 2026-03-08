/**
 * dateFormat — Discord-style message timestamp formatting.
 *
 * Format rules:
 * - Today:        "22:15"
 * - Yesterday:    "Yesterday 22:15"
 * - This week:    "Friday 22:15"
 * - This year:    "1 March 22:15"
 * - Older:        "27 February 2025 22:15"
 *
 * Locale param comes from i18next.language — auto-localizes day/month names.
 */

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatTimeOnly(date: Date, locale: string): string {
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Formats message timestamp to a human-friendly short format.
 *
 * @param dateStr - ISO 8601 date string (backend created_at)
 * @param locale  - i18next.language value ("tr", "en", etc.)
 * @param labels  - i18n labels: { yesterday: string }
 */
export function formatMessageTime(
  dateStr: string,
  locale: string,
  labels: { yesterday: string }
): string {
  const date = new Date(dateStr);
  const now = new Date();

  const todayStart = startOfDay(now);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  const time = formatTimeOnly(date, locale);

  // Today
  if (date >= todayStart) {
    return time;
  }

  // Yesterday
  if (date >= yesterdayStart) {
    return `${labels.yesterday} ${time}`;
  }

  // Last 7 days
  if (date >= weekStart) {
    const dayName = date.toLocaleDateString(locale, { weekday: "long" });
    const capitalized = dayName.charAt(0).toUpperCase() + dayName.slice(1);
    return `${capitalized} ${time}`;
  }

  // This year
  if (date.getFullYear() === now.getFullYear()) {
    const datePart = date.toLocaleDateString(locale, { day: "numeric", month: "long" });
    return `${datePart} ${time}`;
  }

  // Older
  const datePart = date.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${datePart} ${time}`;
}

/** Full date format for hover tooltip: "01/03/2025 22:15" */
export function formatFullDateTime(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
