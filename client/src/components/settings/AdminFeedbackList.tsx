/** AdminFeedbackList — Platform admin feedback ticket management. */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import {
  adminListFeedbackTickets,
  adminGetFeedbackTicket,
  adminReplyToFeedback,
  adminUpdateFeedbackStatus,
} from "../../api/feedback";
import type { FeedbackTicket, FeedbackReply, FeedbackStatus, FeedbackType } from "../../types";

const STATUS_OPTIONS: Array<FeedbackStatus | ""> = ["", "open", "in_progress", "resolved", "closed"];
const TYPE_OPTIONS: Array<FeedbackType | ""> = ["", "bug", "suggestion", "question", "other"];

function AdminFeedbackList() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  const [tickets, setTickets] = useState<FeedbackTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | "">("");
  const [typeFilter, setTypeFilter] = useState<FeedbackType | "">("");

  // Detail view
  const [activeTicket, setActiveTicket] = useState<FeedbackTicket | null>(null);
  const [replies, setReplies] = useState<FeedbackReply[]>([]);
  const [replyContent, setReplyContent] = useState("");
  const [isSendingReply, setIsSendingReply] = useState(false);

  const fetchTickets = useCallback(async () => {
    setIsLoading(true);
    const res = await adminListFeedbackTickets({
      status: statusFilter || undefined,
      type: typeFilter || undefined,
    });
    if (res.success && res.data) {
      setTickets(res.data.tickets ?? []);
      setTotal(res.data.total);
    } else {
      addToast("error", res.error ?? t("feedbackLoadError"));
    }
    setIsLoading(false);
  }, [statusFilter, typeFilter, addToast, t]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const openTicket = async (ticketId: string) => {
    const res = await adminGetFeedbackTicket(ticketId);
    if (res.success && res.data) {
      setActiveTicket(res.data.ticket);
      setReplies(res.data.replies ?? []);
    } else {
      addToast("error", t("feedbackLoadError"));
    }
  };

  const handleReply = async () => {
    if (!replyContent.trim() || !activeTicket) return;
    setIsSendingReply(true);
    const res = await adminReplyToFeedback(activeTicket.id, replyContent.trim());
    if (res.success && res.data) {
      setReplies((prev) => [...prev, res.data!]);
      setReplyContent("");
    } else {
      addToast("error", res.error ?? t("feedbackReplyError"));
    }
    setIsSendingReply(false);
  };

  const handleStatusChange = async (newStatus: string) => {
    if (!activeTicket) return;
    const res = await adminUpdateFeedbackStatus(activeTicket.id, newStatus);
    if (res.success) {
      setActiveTicket((prev) => prev ? { ...prev, status: newStatus as FeedbackStatus } : null);
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
  };

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
            {STATUS_OPTIONS.filter((s) => s !== "").map((s) => (
              <option key={s} value={s}>{t(`feedbackStatus_${s}`)}</option>
            ))}
          </select>
          <span className="feedback-ticket-date">
            {activeTicket.display_name ?? activeTicket.username} — {new Date(activeTicket.created_at).toLocaleString()}
          </span>
        </div>

        <div className="feedback-detail-content">
          <p>{activeTicket.content}</p>
        </div>

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
                  {new Date(reply.created_at).toLocaleString()}
                </span>
              </div>
              <p className="feedback-reply-content">{reply.content}</p>
            </div>
          ))}
        </div>

        <div className="feedback-reply-input">
          <textarea
            className="settings-input"
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            placeholder={t("feedbackReplyPlaceholder")}
            rows={3}
            maxLength={5000}
          />
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

  // ─── List View ───
  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("adminFeedbackTitle")}</h2>

      <div className="admin-report-toolbar">
        <select
          className="admin-report-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FeedbackStatus | "")}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === "" ? t("adminFeedbackAllStatuses") : t(`feedbackStatus_${s}`)}
            </option>
          ))}
        </select>
        <select
          className="admin-report-status-filter"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as FeedbackType | "")}
        >
          {TYPE_OPTIONS.map((tp) => (
            <option key={tp} value={tp}>
              {tp === "" ? t("adminFeedbackAllTypes") : t(`feedbackType_${tp}`)}
            </option>
          ))}
        </select>
        <span className="admin-report-count">{total}</span>
      </div>

      {isLoading && tickets.length === 0 && (
        <p className="settings-empty">{t("feedbackLoading")}</p>
      )}
      {!isLoading && tickets.length === 0 && (
        <p className="settings-empty">{t("adminFeedbackEmpty")}</p>
      )}

      <div className="feedback-list">
        {tickets.map((ticket) => (
          <button
            key={ticket.id}
            className="feedback-ticket-row"
            onClick={() => openTicket(ticket.id)}
          >
            <span className={`feedback-type-badge feedback-type-${ticket.type}`}>
              {t(`feedbackType_${ticket.type}`)}
            </span>
            <span className="feedback-ticket-subject">{ticket.subject}</span>
            <span className="feedback-ticket-user">
              {ticket.display_name ?? ticket.username}
            </span>
            <span className={`feedback-status-badge feedback-status-${ticket.status}`}>
              {t(`feedbackStatus_${ticket.status}`)}
            </span>
            {(ticket.reply_count ?? 0) > 0 && (
              <span className="feedback-reply-count">
                {ticket.reply_count} {t("feedbackReplies")}
              </span>
            )}
            <span className="feedback-ticket-date">
              {new Date(ticket.created_at).toLocaleDateString()}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default AdminFeedbackList;
