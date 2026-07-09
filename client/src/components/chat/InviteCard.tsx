/** InviteCard — Rich preview card for invite links in messages. Fetches server info and handles join. */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { resolveAssetUrl, getInviteUrl, copyToClipboard } from "../../utils/constants";
import { getInvitePreview, type InvitePreview } from "../../api/invites";
import * as serversApi from "../../api/servers";
import Avatar from "../shared/Avatar";

type InviteCardProps = {
  code: string;
};

function InviteCard({ code }: InviteCardProps) {
  const { t } = useTranslation("servers");
  const addToast = useToastStore((s) => s.addToast);
  const [isJoining, setIsJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [pending, setPending] = useState(false);

  /** Preview data — null if not loaded yet or invalid code */
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  // Fetch preview on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await getInvitePreview(code);
      if (cancelled) return;
      if (res.success && res.data) {
        setPreview(res.data);
      }
      setPreviewLoaded(true);
    }
    load();
    return () => { cancelled = true; };
  }, [code]);

  async function handleCopy() {
    await copyToClipboard(getInviteUrl(code));
    addToast("success", t("inviteLinkCopied"));
  }

  async function handleJoin() {
    if (isJoining || joined || pending) return;
    setIsJoining(true);

    // Call API directly to parse error messages
    const res = await serversApi.joinServer(code);
    if (res.success && res.data) {
      // Approval-required server — request queued, no membership yet.
      if (res.data.pending) {
        addToast("info", t("joinRequestSent"));
        setPending(true);
        setIsJoining(false);
        return;
      }
      const server = res.data.server;
      if (server) {
        const store = useServerStore.getState();
        const exists = store.servers.some((s) => s.id === server.id);
        if (!exists) {
          useServerStore.setState((state) => ({
            servers: [...state.servers, { id: server.id, name: server.name, icon_url: server.icon_url }],
          }));
        }
        useServerStore.setState({ activeServerId: server.id, activeServer: server });
        addToast("success", t("serverJoined"));
        setJoined(true);
      }
    } else {
      // Parse error — backend returns specific messages
      const err = res.error ?? "";
      if (err.includes("already a member")) {
        addToast("info", t("alreadyMember"));
      } else {
        addToast("error", t("inviteExpired"));
      }
    }
    setIsJoining(false);
  }

  // Minimal skeleton until preview loads
  if (!previewLoaded) {
    return (
      <span className="invite-card">
        <span className="invite-card-info">
          <span className="invite-card-name">...</span>
        </span>
      </span>
    );
  }

  return (
    <span className="invite-card" onClick={(e) => e.stopPropagation()}>
      {/* Server icon */}
      <span className="invite-card-icon">
        {preview?.server_icon_url ? (
          <img
            src={resolveAssetUrl(preview.server_icon_url)}
            alt={preview.server_name}
            className="invite-card-img"
          />
        ) : (
          <Avatar
            name={preview?.server_name ?? "?"}
            size={36}
          />
        )}
      </span>

      {/* Server info */}
      <span className="invite-card-info">
        <span className="invite-card-name">
          {preview?.server_name ?? t("inviteFriends")}
        </span>
        <span className="invite-card-meta">
          {preview
            ? t("memberCount", { count: preview.member_count })
            : code}
        </span>
      </span>

      {/* Actions: copy link + join */}
      <span className="invite-card-actions">
        <button
          className="invite-card-copy"
          onClick={handleCopy}
          title={t("copyInviteLink")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          {t("copyLink")}
        </button>
        <button
          className="invite-card-btn"
          onClick={handleJoin}
          disabled={isJoining || joined || pending}
        >
          {joined
            ? "\u2713"
            : pending
              ? t("joinRequestPendingTitle")
              : isJoining
                ? "..."
                : t("joinInvite")}
        </button>
      </span>
    </span>
  );
}

export default InviteCard;
