/** AdminFeedbackList — Platform admin feedback ticket datagrid + detail view. */

import { useEffect, useState, useCallback, useRef } from "react";

import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsBadgeStore } from "../../stores/settingsBadgeStore";
import {
  adminListFeedbackTickets,
  adminGetFeedbackTicket,
  adminReplyToFeedback,
  adminUpdateFeedbackStatus,
} from "../../api/feedback";
import type { FeedbackTicket, FeedbackReply, FeedbackStatus, FeedbackType } from "../../types";
import { resolveAssetUrl, FEEDBACK_ACCEPT_ATTR, isFeedbackAttachment } from "../../utils/constants";
import AttachmentPreview from "../shared/AttachmentPreview";
import { useAttachmentViewer } from "../../hooks/useAttachmentViewer";
import { useUploadProgress } from "../../hooks/useUploadProgress";
import UploadProgress from "../shared/UploadProgress";
import { useImageAttach } from "../../hooks/useImageAttach";
import FilePreview from "../chat/FilePreview";
import FilterDropdown, { type FilterOption } from "../shared/FilterDropdown";
import Pagination from "../shared/Pagination";

const STATUS_VALUES: FeedbackStatus[] = ["open", "in_progress", "resolved", "closed"];
const TYPE_VALUES: FeedbackType[] = ["bug", "suggestion", "question", "other"];

type SortKey = "type" | "subject" | "username" | "status" | "reply_count" | "created_at" | "updated_at";

type Column = { key: SortKey; labelKey: string; align?: "right" };

const COLUMNS: Column[] = [
  { key: "type", labelKey: "feedbackColType" },
  { key: "subject", labelKey: "feedbackColSubject" },
  { key: "username", labelKey: "feedbackColUser" },
  { key: "status", labelKey: "feedbackColStatus" },
  { key: "reply_count", labelKey: "feedbackColReplies", align: "right" },
  { key: "created_at", labelKey: "feedbackColCreated" },
  { key: "updated_at", labelKey: "feedbackColUpdated" },
];

/** SQLite timestamps may lack the "Z" suffix — append it to force UTC parsing. */
function parseUTC(iso: string): number {
  return new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
}

function AdminFeedbackList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const openAttachment = useAttachmentViewer();
  const { progress: uploadProgress, begin: beginUpload, end: endUpload, cancel: cancelUpload } =
    useUploadProgress();

  const [tickets, setTickets] = useState<FeedbackTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Filters / sort / paging ───
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // ─── Detail view ───
  const [activeTicket, setActiveTicket] = useState<FeedbackTicket | null>(null);
  const [replies, setReplies] = useState<FeedbackReply[]>([]);
  const [replyContent, setReplyContent] = useState("");
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const replyFileInputRef = useRef<HTMLInputElement>(null);
  const [isSendingReply, setIsSendingReply] = useState(false);

  const MAX_REPLY_FILES = 4;
  const onReplyLimit = useCallback(() => addToast("warning", t("feedbackMaxFiles")), [addToast, t]);
  const {
    addFiles: addReplyFiles,
    handlePaste: handleReplyPaste,
    isDragging: isReplyDragging,
    dragHandlers: replyDragHandlers,
  } = useImageAttach(setReplyFiles, MAX_REPLY_FILES, onReplyLimit, isFeedbackAttachment);

  const fetchTickets = useCallback(async () => {
    setIsLoading(true);
    const res = await adminListFeedbackTickets({
      statuses: statusFilter,
      types: typeFilter,
      sort: sortKey,
      dir: sortDir,
      limit: pageSize,
      offset: page * pageSize,
    });
    if (res.success && res.data) {
      setTickets(res.data.tickets ?? []);
      setTotal(res.data.total);
    } else {
      addToast("error", res.error ?? t("feedbackLoadError"));
    }
    setIsLoading(false);
  }, [statusFilter, typeFilter, sortKey, sortDir, page, pageSize, addToast, t]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  // Any filter/sort/page-size change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [statusFilter, typeFilter, sortKey, sortDir, pageSize]);

  // Clear the admin "new feedback" nav dot once this panel is viewed.
  const clearFeedbackBadge = useSettingsBadgeStore((s) => s.clearFeedback);
  useEffect(() => {
    clearFeedbackBadge();
  }, [clearFeedbackBadge]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const openTicket = async (ticketId: string) => {
    const res = await adminGetFeedbackTicket(ticketId);
    if (res.success && res.data) {
      setActiveTicket(res.data.ticket);
      setReplies(res.data.replies ?? []);
      // The server marks this ticket seen; reflect it immediately in the list.
      setTickets((prev) => prev.map((tk) => (tk.id === ticketId ? { ...tk, is_unread: false } : tk)));
    } else {
      addToast("error", t("feedbackLoadError"));
    }
  };

  const handleReply = async () => {
    if (!replyContent.trim() || !activeTicket) return;
    setIsSendingReply(true);
    const upload = replyFiles.length > 0 ? beginUpload() : undefined;
    const res = await adminReplyToFeedback(
      activeTicket.id,
      replyContent.trim(),
      replyFiles.length > 0 ? replyFiles : undefined,
      upload
    );
    endUpload(upload);
    if (res.success && res.data) {
      setReplies((prev) => [...prev, res.data!]);
      setReplyContent("");
      setReplyFiles([]);
    } else {
      addToast("error", res.error ?? t("feedbackReplyError"));
    }
    setIsSendingReply(false);
  };

  const handleStatusChange = async (newStatus: string) => {
    if (!activeTicket) return;
    const res = await adminUpdateFeedbackStatus(activeTicket.id, newStatus);
    if (res.success) {
      setActiveTicket((prev) => (prev ? { ...prev, status: newStatus as FeedbackStatus } : null));
      addToast("success", t("adminFeedbackStatusUpdated"));
      fetchTickets();
    } else {
      addToast("error", res.error ?? t("adminFeedbackStatusError"));
    }
  };

  const goBack = () => {
    setActiveTicket(null);
    setReplies([]);
    setReplyContent("");
    setReplyFiles([]);
    // Resync so the just-opened ticket's unread dot clears from the grid.
    fetchTickets();
  };

  // ─── Date helpers ───
  function formatDate(iso: string) {
    try {
      return new Date(parseUTC(iso)).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }

  function formatDateTime(iso: string) {
    try {
      return new Date(parseUTC(iso)).toLocaleString();
    } catch {
      return iso;
    }
  }

  function formatRelative(iso: string) {
    try {
      const diff = Date.now() - parseUTC(iso);
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return t("feedbackJustNow");
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days}d`;
      return formatDate(iso);
    } catch {
      return iso;
    }
  }

  // ─── Filter options ───
  const statusOptions: FilterOption[] = STATUS_VALUES.map((s) => ({ value: s, label: t(`feedbackStatus_${s}`) }));
  const typeOptions: FilterOption[] = TYPE_VALUES.map((tp) => ({ value: tp, label: t(`feedbackType_${tp}`) }));

  function renderCell(ticket: FeedbackTicket, key: SortKey) {
    switch (key) {
      case "type":
        return (
          <span className={`feedback-type-badge feedback-type-${ticket.type}`}>
            {t(`feedbackType_${ticket.type}`)}
          </span>
        );
      case "subject":
        return <span className="feedback-cell-subject" title={ticket.subject}>{ticket.subject}</span>;
      case "username":
        return (
          <span className="feedback-cell-user" title={ticket.display_name ?? undefined}>
            {ticket.username}
          </span>
        );
      case "status":
        return (
          <span className={`feedback-status-badge feedback-status-${ticket.status}`}>
            {t(`feedbackStatus_${ticket.status}`)}
          </span>
        );
      case "reply_count":
        return ticket.reply_count ?? 0;
      case "created_at":
        return <span title={formatDateTime(ticket.created_at)}>{formatDate(ticket.created_at)}</span>;
      case "updated_at":
        return <span title={formatDateTime(ticket.updated_at)}>{formatRelative(ticket.updated_at)}</span>;
      default:
        return null;
    }
  }

  // ─── Detail View ───
  if (activeTicket) {
    return (
      <div className="settings-section">
        <div className="settings-section-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 className="settings-section-title">{activeTicket.subject}</h2>
          <button className="settings-btn settings-btn-secondary" onClick={goBack}>
            {t("feedbackBackToList")}
          </button>
        </div>

        <div className="feedback-detail-meta">
          <span className={`feedback-type-badge feedback-type-${activeTicket.type}`}>
            {t(`feedbackType_${activeTicket.type}`)}
          </span>
          <select
            className="settings-input feedback-status-select"
            value={activeTicket.status}
            onChange={(e) => handleStatusChange(e.target.value)}
          >
            {STATUS_VALUES.map((s) => (
              <option key={s} value={s}>{t(`feedbackStatus_${s}`)}</option>
            ))}
          </select>
          <span className="feedback-ticket-date">
            {activeTicket.display_name ?? activeTicket.username} — {new Date(parseUTC(activeTicket.created_at)).toLocaleString()}
          </span>
        </div>

        <div className="feedback-detail-content">
          <p>{activeTicket.content}</p>
        </div>

        {activeTicket.attachments && activeTicket.attachments.length > 0 && (
          <div className="feedback-attachments">
            {activeTicket.attachments.map((att) => (
              <a
                key={att.id}
                href={resolveAssetUrl(att.file_url)}
                rel="noopener noreferrer"
                className="feedback-attachment-thumb"
                onClick={(e) => openAttachment(att, e)}
              >
                <AttachmentPreview url={resolveAssetUrl(att.file_url)} filename={att.filename} mime={att.mime_type} />
              </a>
            ))}
          </div>
        )}

        <div className="feedback-replies">
          {replies.map((reply) => (
            <div
              key={reply.id}
              className={`feedback-reply ${reply.is_admin ? "feedback-reply-admin" : "feedback-reply-user"}`}
            >
              <div className="feedback-reply-header">
                <span className="feedback-reply-author">
                  {reply.display_name ?? reply.username}
                  {reply.is_admin && <span className="feedback-admin-badge">{t("feedbackAdminBadge")}</span>}
                </span>
                <span className="feedback-reply-date">
                  {new Date(parseUTC(reply.created_at)).toLocaleString()}
                </span>
              </div>
              <p className="feedback-reply-content">{reply.content}</p>
              {reply.attachments && reply.attachments.length > 0 && (
                <div className="feedback-attachments">
                  {reply.attachments.map((att) => (
                    <a key={att.id} href={resolveAssetUrl(att.file_url)} rel="noopener noreferrer" className="feedback-attachment-thumb" onClick={(e) => openAttachment(att, e)}>
                      <AttachmentPreview url={resolveAssetUrl(att.file_url)} filename={att.filename} mime={att.mime_type} />
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="feedback-reply-input" {...replyDragHandlers} onPaste={handleReplyPaste}>
          {isReplyDragging && (
            <div className="file-drop-overlay">
              <span className="file-drop-text">{t("feedbackEvidenceHint")}</span>
            </div>
          )}
          <textarea
            className="settings-input"
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            placeholder={t("feedbackReplyPlaceholder")}
            rows={3}
            maxLength={5000}
          />
          <div className="report-field">
            {replyFiles.length > 0 && (
              <FilePreview files={replyFiles} onRemove={(i) => setReplyFiles((prev) => prev.filter((_, j) => j !== i))} />
            )}
            {replyFiles.length < MAX_REPLY_FILES && (
              <button
                type="button"
                className="report-evidence-drop"
                onClick={() => replyFileInputRef.current?.click()}
              >
                <span className="report-evidence-hint">{t("feedbackEvidenceHint")}</span>
              </button>
            )}
            <input
              ref={replyFileInputRef}
              type="file"
              accept={FEEDBACK_ACCEPT_ATTR}
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) addReplyFiles(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
          </div>
          {uploadProgress && (
            <UploadProgress
              loaded={uploadProgress.loaded}
              total={uploadProgress.total}
              onCancel={cancelUpload}
            />
          )}
          <button
            className="settings-btn settings-btn-primary"
            onClick={handleReply}
            disabled={isSendingReply || !replyContent.trim()}
          >
            {isSendingReply ? t("feedbackSending") : t("feedbackSendReply")}
          </button>
        </div>
      </div>
    );
  }

  // ─── List View (datagrid) ───
  return (
    <div className="admin-feedback-list">
      <div className="admin-feedback-toolbar">
        <FilterDropdown
          label={t("feedbackFilterStatus")}
          options={statusOptions}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
        <FilterDropdown
          label={t("feedbackFilterType")}
          options={typeOptions}
          selected={typeFilter}
          onChange={setTypeFilter}
        />
        <span className="admin-feedback-count">{total}</span>
      </div>

      {tickets.length === 0 ? (
        <p className="no-channel">
          {isLoading ? t("feedbackLoading") : t("adminFeedbackEmpty")}
        </p>
      ) : (
        <div className={`admin-feedback-table-wrap${isLoading ? " is-loading" : ""}`}>
          <table className="admin-feedback-table">
            <thead>
              <tr>
                <th className="feedback-th-dot" aria-hidden="true" />
                {COLUMNS.map((col) => (
                  <th key={col.key} className="sortable" onClick={() => handleSort(col.key)}>
                    <div
                      className="feedback-th-content"
                      style={{ justifyContent: col.align === "right" ? "flex-end" : "flex-start" }}
                    >
                      <span>{t(col.labelKey)}</span>
                      {sortKey === col.key && (
                        <span className="feedback-sort-icon">{sortDir === "asc" ? "▲" : "▼"}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr
                  key={ticket.id}
                  className={`feedback-grid-row${ticket.is_unread ? " unread" : ""}`}
                  onClick={() => openTicket(ticket.id)}
                >
                  <td className="feedback-td-dot">
                    {ticket.is_unread && (
                      <span className="feedback-unread-dot" title={t("feedbackUnreadTitle")} />
                    )}
                  </td>
                  {COLUMNS.map((col) => (
                    <td key={col.key} style={{ textAlign: col.align ?? "left" }}>
                      {renderCell(ticket, col.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

export default AdminFeedbackList;
