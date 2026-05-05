/** StorageUsage — Shows current user's storage usage with a progress bar. */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getStorageUsage, type StorageUsage } from "../../api/profile";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function StorageUsageBar() {
  const { t } = useTranslation("settings");
  const [usage, setUsage] = useState<StorageUsage | null>(null);

  useEffect(() => {
    getStorageUsage().then(setUsage).catch(() => {});
  }, []);

  if (!usage) return null;

  const percent = usage.quota_bytes > 0
    ? Math.min(100, (usage.bytes_used / usage.quota_bytes) * 100)
    : 0;

  const isWarning = percent > 80;
  const isCritical = percent > 95;

  return (
    <div className="storage-usage-section">
      <h4 className="settings-section-title">{t("storageUsage")}</h4>
      <div className="storage-bar-container">
        <div
          className={`storage-bar-fill${isCritical ? " storage-bar-critical" : isWarning ? " storage-bar-warning" : ""}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="storage-usage-text">
        {formatBytes(usage.bytes_used)} / {formatBytes(usage.quota_bytes)} ({percent.toFixed(1)}%)
      </p>
    </div>
  );
}

export default StorageUsageBar;
