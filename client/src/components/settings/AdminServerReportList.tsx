/** AdminServerReportList — platform admin view of user reports against public servers. */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { listAdminServerReports, updateServerReportStatus } from "../../api/admin";
import Modal from "../shared/Modal";
import { resolveAssetUrl } from "../../utils/constants";
import { useAttachmentViewer } from "../../hooks/useAttachmentViewer";
import type { AdminServerReportItem } from "../../types";

const STATUS_KEY_MAP: Record<string, string> = {
  pending: "platformReportStatusPending",
  reviewed: "platformReportStatusReviewed",
  resolved: "platformReportStatusResolved",
  dismissed: "platformReportStatusDismissed",
};

const REASON_KEY_MAP: Record<string, string> = {
  spam: "platformReportReasonSpam",
  harassment: "platformReportReasonHarassment",
  inappropriate_content: "platformReportReasonInappropriate",
  impersonation: "platformReportReasonImpersonation",
  other: "platformReportReasonOther",
};

const STATUS_OPTIONS = ["", "pending", "reviewed", "resolved", "dismissed"] as const;

function formatDateTime(iso: string) {
  try {
    return new Date(iso.endsWith("Z") ? iso : iso + "Z").toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function AdminServerReportList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const openAttachment = useAttachmentViewer();

  const [reports, setReports] = useState<AdminServerReportItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [pendingStatus, setPendingStatus] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [attachModal, setAttachModal] = useState<AdminServerReportItem | null>(null);

  const fetchReports = useCallback(async () => {
    setIsLoading(true);
    const res = await listAdminServerReports(statusFilter || undefined);
    if (res.success && res.data) {
      setReports(res.data.reports);
    } else {
      addToast("error", res.error ?? t("platformReportLoadError"));
    }
    setIsLoading(false);
  }, [statusFilter, addToast, t]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  function handleStatusChange(id: string, next: string, original: string) {
    setPendingStatus((prev) => {
      const copy = { ...prev };
      if (next === original) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  }

  async function handleConfirm(id: string) {
    const next = pendingStatus[id];
    if (!next) return;
    setSaving((prev) => new Set(prev).add(id));
    const res = await updateServerReportStatus(id, next);
    if (res.success) {
      addToast("success", t("platformReportStatusUpdated"));
      setPendingStatus((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      await fetchReports();
    } else {
      addToast("error", res.error ?? t("platformReportStatusUpdateError"));
    }
    setSaving((prev) => {
      const copy = new Set(prev);
      copy.delete(id);
      return copy;
    });
  }

  if (isLoading) {
    return (
      <div className="admin-report-list">
        <p className="no-channel">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="admin-report-list">
      <div className="admin-report-toolbar">
        <select
          className="admin-report-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === "" ? t("platformReportStatusAll") : t(STATUS_KEY_MAP[s] ?? s)}
            </option>
          ))}
        </select>
        <span className="admin-report-count">{reports.length}</span>
      </div>

      {reports.length === 0 ? (
        <p className="no-channel">{t("platformServerReportsEmpty")}</p>
      ) : (
        <div className="admin-report-table-wrap">
          <table className="admin-report-table">
            <thead>
              <tr>
                <th>{t("platformReportReporter")}</th>
                <th>{t("platformServerReportServer")}</th>
                <th>{t("platformReportReason")}</th>
                <th>{t("platformReportDescription")}</th>
                <th>{t("platformReportFiles")}</th>
                <th>{t("platformReportDate")}</th>
                <th>{t("platformReportStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const hasPending = pendingStatus[r.id] !== undefined;
                const isSaving = saving.has(r.id);
                const current = hasPending ? pendingStatus[r.id] : r.status;
                return (
                  <tr key={r.id}>
                    <td>{r.reporter_username}</td>
                    <td>{r.server_name}</td>
                    <td>
                      <span className={`admin-report-reason-badge ${r.reason}`}>
                        {t(REASON_KEY_MAP[r.reason] ?? "platformReportReasonOther")}
                      </span>
                    </td>
                    <td>
                      <span className="admin-report-desc-cell" title={r.description}>
                        {r.description}
                      </span>
                    </td>
                    <td>
                      {r.attachments.length > 0 ? (
                        <button className="admin-report-attach-btn" onClick={() => setAttachModal(r)}>
                          {t("platformReportFileCount", { count: r.attachments.length })}
                        </button>
                      ) : (
                        <span className="admin-report-text-muted">{"—"}</span>
                      )}
                    </td>
                    <td>{formatDateTime(r.created_at)}</td>
                    <td>
                      <div className="admin-report-status-cell">
                        <select
                          className="admin-report-status-select"
                          value={current}
                          onChange={(e) => handleStatusChange(r.id, e.target.value, r.status)}
                          disabled={isSaving}
                        >
                          {Object.entries(STATUS_KEY_MAP).map(([value, labelKey]) => (
                            <option key={value} value={value}>
                              {t(labelKey)}
                            </option>
                          ))}
                        </select>
                        {hasPending && (
                          <button
                            className="admin-report-confirm-btn"
                            onClick={() => handleConfirm(r.id)}
                            disabled={isSaving}
                            title={t("save")}
                          >
                            {isSaving ? "..." : "✓"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={!!attachModal}
        onClose={() => setAttachModal(null)}
        title={t("platformReportAttachments")}
      >
        {attachModal && attachModal.attachments.length > 0 ? (
          <div className="admin-report-attach-modal">
            {attachModal.attachments.map((att) => (
              <div key={att.id} className="admin-report-attach-item">
                {att.mime_type?.startsWith("image/") ? (
                  <img
                    src={resolveAssetUrl(att.file_url)}
                    alt={att.filename}
                    className="admin-report-attach-img"
                    onClick={() => openAttachment(att)}
                  />
                ) : (
                  <a
                    href={resolveAssetUrl(att.file_url)}
                    rel="noopener noreferrer"
                    className="admin-report-attach-link"
                    onClick={(e) => openAttachment(att, e)}
                  >
                    {att.filename}
                  </a>
                )}
                <div className="admin-report-attach-info">
                  <span>{att.filename}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="admin-report-no-attach">{t("platformReportNoAttachments")}</p>
        )}
      </Modal>
    </div>
  );
}

export default AdminServerReportList;
