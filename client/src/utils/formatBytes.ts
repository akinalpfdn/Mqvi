/**
 * Human-readable byte sizes. The canonical implementation — the private copies that used to sit in
 * the attachment, viewer and admin components now call this. StorageUsage keeps its own, which
 * formats against a quota rather than a plain size.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  // Bytes never need a decimal; everything above reads better with one.
  return exponent === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[exponent]}`;
}
