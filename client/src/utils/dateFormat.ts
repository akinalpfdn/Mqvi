/**
 * dateFormat — Mesaj timestamp'lerini kullanıcı dostu formata çeviren utility.
 *
 * Format kuralları (Discord benzeri):
 * - Bugün:           "22:15"
 * - Dün:             "Dün 22:15"  /  "Yesterday 22:15"
 * - Bu hafta (2-6):  "Cuma 22:15" /  "Friday 22:15"
 * - Bu yıl (7+):     "1 Mart 22:15"    /  "1 March 22:15"
 * - Geçen yıl+:      "27 Şubat 2025 22:15" / "27 February 2025 22:15"
 *
 * Hover tooltip için tam tarih: "01/03/2025 22:15"
 *
 * locale parametresi i18next.language'dan gelir — gün/ay adları otomatik
 * Türkçe veya İngilizce olur.
 */

/** Bugünün başlangıcı (00:00) — karşılaştırma için */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Saat formatı: "22:15" */
function formatTimeOnly(date: Date, locale: string): string {
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Mesaj timestamp'ini kullanıcı dostu kısa formata çevirir.
 *
 * @param dateStr - ISO 8601 tarih string'i (backend'den gelen created_at)
 * @param locale  - i18next.language değeri ("tr", "en", vb.)
 * @param labels  - i18n çeviri objeleri: { yesterday: string }
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

  // Bugün → sadece saat
  if (date >= todayStart) {
    return time;
  }

  // Dün → "Dün 22:15"
  if (date >= yesterdayStart) {
    return `${labels.yesterday} ${time}`;
  }

  // Son 7 gün → "Cuma 22:15"
  if (date >= weekStart) {
    const dayName = date.toLocaleDateString(locale, { weekday: "long" });
    // İlk harfi büyük yap (bazı locale'ler küçük harf dönebilir)
    const capitalized = dayName.charAt(0).toUpperCase() + dayName.slice(1);
    return `${capitalized} ${time}`;
  }

  // Bu yıl → "1 Mart 22:15"
  if (date.getFullYear() === now.getFullYear()) {
    const datePart = date.toLocaleDateString(locale, { day: "numeric", month: "long" });
    return `${datePart} ${time}`;
  }

  // Geçen yıl+ → "27 Şubat 2025 22:15"
  const datePart = date.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${datePart} ${time}`;
}

/**
 * Hover tooltip için tam tarih formatı: "01/03/2025 22:15"
 */
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
