/** JoinRequestsSettings — approve/reject pending join requests (PermApproveMembers). */

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useServerStore } from "../../stores/serverStore";
import { useJoinRequestStore } from "../../stores/joinRequestStore";
import {
  listJoinRequests,
  approveJoinRequest,
  rejectJoinRequest,
} from "../../api/joinRequests";
import type { JoinRequest } from "../../types";
import { resolveAssetUrl } from "../../utils/constants";

function JoinRequestsSettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const pendingCount = useJoinRequestStore((s) =>
    activeServerId ? s.pendingCounts[activeServerId] : undefined
  );
  const setPendingCount = useJoinRequestStore((s) => s.setPendingCount);

  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const fetchRequests = useCallback(async () => {
    if (!activeServerId) return;
    setIsLoading(true);
    const res = await listJoinRequests(activeServerId);
    if (res.success && res.data) {
      setRequests(res.data.requests ?? []);
      setPendingCount(activeServerId, res.data.total);
    } else {
      addToast("error", res.error ?? t("joinRequestsLoadError"));
    }
    setIsLoading(false);
  }, [activeServerId, addToast, setPendingCount, t]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // Live refresh: refetch when a WS `join_request_update` changes the count (someone
  // requested or withdrew). The ref guard skips the initial set so the mount fetch
  // above isn't duplicated and there's no fetch loop.
  const prevCountRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (prevCountRef.current !== undefined && prevCountRef.current !== pendingCount) {
      fetchRequests();
    }
    prevCountRef.current = pendingCount;
  }, [pendingCount, fetchRequests]);

  function setBusy(userId: string, busy: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  async function handleApprove(req: JoinRequest) {
    if (!activeServerId) return;
    setBusy(req.user_id, true);
    const res = await approveJoinRequest(activeServerId, req.user_id);
    setBusy(req.user_id, false);
    if (res.success) {
      setRequests((prev) => prev.filter((r) => r.user_id !== req.user_id));
      addToast("success", t("joinRequestApproved", { user: req.display_name ?? req.username }));
    } else {
      addToast("error", res.error ?? t("joinRequestActionError"));
      fetchRequests();
    }
  }

  async function handleReject(req: JoinRequest) {
    if (!activeServerId) return;
    setBusy(req.user_id, true);
    const res = await rejectJoinRequest(activeServerId, req.user_id);
    setBusy(req.user_id, false);
    if (res.success) {
      setRequests((prev) => prev.filter((r) => r.user_id !== req.user_id));
    } else {
      addToast("error", res.error ?? t("joinRequestActionError"));
      fetchRequests();
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("joinRequestsTitle")}</h2>
      <p className="join-request-desc">{t("joinRequestsDesc")}</p>

      {isLoading && requests.length === 0 && (
        <p className="settings-empty">{t("loading")}</p>
      )}
      {!isLoading && requests.length === 0 && (
        <p className="settings-empty">{t("joinRequestsEmpty")}</p>
      )}

      <div className="join-request-list">
        {requests.map((req) => (
          <div key={req.user_id} className="join-request-row">
            <div className="join-request-user">
              <div className="join-request-avatar">
                {req.avatar_url ? (
                  <img src={resolveAssetUrl(req.avatar_url)} alt="" />
                ) : (
                  (req.display_name ?? req.username).charAt(0).toUpperCase()
                )}
              </div>
              <div className="join-request-meta">
                <span className="join-request-name">{req.display_name ?? req.username}</span>
                <span className="join-request-sub">
                  @{req.username} · {new Date(req.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
            <div className="join-request-actions">
              <button
                className="settings-btn settings-btn-primary"
                disabled={busyIds.has(req.user_id)}
                onClick={() => handleApprove(req)}
              >
                {t("joinRequestApprove")}
              </button>
              <button
                className="settings-btn settings-btn-secondary"
                disabled={busyIds.has(req.user_id)}
                onClick={() => handleReject(req)}
              >
                {t("joinRequestReject")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default JoinRequestsSettings;
