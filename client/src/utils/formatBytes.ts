/**
 * Human-readable byte sizes.
 *
 * Six near-identical private copies of this already exist (MessageAttachments, EncryptedAttachment,
 * FileViewerOverlay, AdminReportList, MetricsPanel, StorageUsage). This is the canonical one for new
 * code; consolidating the older copies is a separate refactor, not part of the upload work.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  // Bytes never need a decimal; everything above reads better with one.
  return exponent === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[exponent]}`;
}
