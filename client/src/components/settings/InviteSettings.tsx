/** InviteSettings — Invite code management (create, list, copy, delete). */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInviteStore } from "../../stores/inviteStore";
import { useToastStore } from "../../stores/toastStore";
import { getInviteUrl, copyToClipboard } from "../../utils/constants";

/** Expiry options in minutes. 0 = never. */
const EXPIRY_OPTIONS = [
  { value: 30, labelKey: "expiry30min" },
  { value: 60, labelKey: "expiry1h" },
  { value: 360, labelKey: "expiry6h" },
  { value: 720, labelKey: "expiry12h" },
  { value: 1440, labelKey: "expiry1d" },
  { value: 10080, labelKey: "expiry7d" },
  { value: 0, labelKey: "expiryNever" },
] as const;

/** Max uses options. 0 = unlimited. */
const MAX_USES_OPTIONS = [
  { value: 0, labelKey: "usesNoLimit" },
  { value: 1, labelKey: "uses1" },
  { value: 5, labelKey: "uses5" },
  { value: 10, labelKey: "uses10" },
  { value: 25, labelKey: "uses25" },
  { value: 50, labelKey: "uses50" },
  { value: 100, labelKey: "uses100" },
] as const;

function InviteSettings() {
  const { t } = useTranslation("settings");
  const invites = useInviteStore((s) => s.invites);
  const isLoading = useInviteStore((s) => s.isLoading);
  const fetchInvites = useInviteStore((s) => s.fetchInvites);
  const createInvite = useInviteStore((s) => s.createInvite);
  const deleteInvite = useInviteStore((s) => s.deleteInvite);
  const addToast = useToastStore((s) => s.addToast);

  const [expiresIn, setExpiresIn] = useState(1440);
  const [maxUses, setMaxUses] = useState(0);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  const handleCreate = useCallback(async () => {
    if (isCreating) return;
    setIsCreating(true);

    const invite = await createInvite(maxUses, expiresIn);
    if (invite) {
      addToast("success", t("inviteCreated"));
      // Auto-copy link for easy sharing
      try {
        await copyToClipboard(getInviteUrl(invite.code));
        addToast("success", t("inviteLinkCopied"));
      } catch {
        // Clipboard API not available
      }
    } else {
      addToast("error", t("inviteCreateError"));
    }

    setIsCreating(false);
  }, [isCreating, createInvite, maxUses, expiresIn, addToast, t]);

  /** Copy raw invite code */
  const handleCopyCode = useCallback(
    async (code: string) => {
      try {
        await copyToClipboard(code);
        addToast("success", t("inviteCopied"));
      } catch {
        addToast("error", t("inviteCopyError"));
      }
    },
    [addToast, t]
  );

  /** Copy full invite URL */
  const handleCopyLink = useCallback(
    async (code: string) => {
      try {
        await copyToClipboard(getInviteUrl(code));
        addToast("success", t("inviteLinkCopied"));
      } catch {
        addToast("error", t("inviteCopyError"));
      }
    },
    [addToast, t]
  );

  const handleDelete = useCallback(
    async (code: string) => {
      const success = await deleteInvite(code);
      if (success) {
        addToast("success", t("inviteDeleted"));
      } else {
        addToast("error", t("inviteDeleteError"));
      }
    },
    [deleteInvite, addToast, t]
  );

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("invites")}</h2>

      {/* Create form */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 24 }}>
        {/* Expiry */}
        <div className="settings-field" style={{ marginBottom: 0 }}>
          <label className="settings-label">{t("inviteExpiry")}</label>
          <select
            value={expiresIn}
            onChange={(e) => setExpiresIn(Number(e.target.value))}
            className="settings-select"
            style={{ maxWidth: 180 }}
          >
            {EXPIRY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </div>

        {/* Max Uses */}
        <div className="settings-field" style={{ marginBottom: 0 }}>
          <label className="settings-label">{t("inviteMaxUses")}</label>
          <select
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value))}
            className="settings-select"
            style={{ maxWidth: 160 }}
          >
            {MAX_USES_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </div>

        {/* Create button */}
        <button
          onClick={handleCreate}
          disabled={isCreating}
          className="settings-btn"
        >
          {isCreating ? t("inviteCreating") : t("inviteCreate")}
        </button>
      </div>

      <div style={{ height: 1, background: "var(--b1)", marginBottom: 16 }} />

      {isLoading ? (
        <p style={{ fontSize: 13, color: "var(--t2)" }}>{t("loading")}</p>
      ) : invites.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--t2)" }}>{t("noInvites")}</p>
      ) : (
        <div className="invite-list">
          {invites.map((invite) => (
            <InviteItem
              key={invite.code}
              invite={invite}
              onCopyCode={handleCopyCode}
              onCopyLink={handleCopyLink}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}


type InviteItemProps = {
  invite: {
    code: string;
    creator_username: string;
    creator_display_name: string | null;
    max_uses: number;
    uses: number;
    expires_at: string | null;
  };
  onCopyCode: (code: string) => void;
  onCopyLink: (code: string) => void;
  onDelete: (code: string) => void;
};

function InviteItem({ invite, onCopyCode, onCopyLink, onDelete }: InviteItemProps) {
  const { t } = useTranslation("settings");

  const isExpired =
    invite.expires_at !== null && new Date(invite.expires_at) < new Date();
  const isMaxed =
    invite.max_uses > 0 && invite.uses >= invite.max_uses;
  const isInvalid = isExpired || isMaxed;

  const creatorName = invite.creator_display_name ?? invite.creator_username;

  function formatExpiry(): string {
    if (!invite.expires_at) return t("expiryNever");
    if (isExpired) return t("inviteExpired");

    const diff = new Date(invite.expires_at).getTime() - Date.now();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return t("inviteExpiresInDays", { count: days });
    }
    if (hours > 0) {
      return t("inviteExpiresInHours", { count: hours });
    }
    return t("inviteExpiresInMinutes", { count: minutes });
  }

  return (
    <div
      className="invite-item"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 12px",
        background: isInvalid ? "var(--red-s)" : "var(--bg-3)",
        borderRadius: 8,
        marginBottom: 6,
        opacity: isInvalid ? 0.6 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: "var(--f-m)",
            fontSize: 14,
            fontWeight: 500,
            color: "var(--t0)",
            letterSpacing: "0.02em",
          }}
        >
          {invite.code}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--t2)",
            marginTop: 2,
            display: "flex",
            gap: 12,
          }}
        >
          <span>{creatorName}</span>
          <span>
            {invite.uses}
            {invite.max_uses > 0 ? ` / ${invite.max_uses}` : ""}{" "}
            {t("inviteUsesLabel")}
          </span>
          <span>{formatExpiry()}</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button
          onClick={() => onCopyCode(invite.code)}
          className="settings-btn settings-btn-secondary"
          style={{ height: 28, padding: "0 10px", fontSize: 13 }}
          title={invite.code}
        >
          {t("inviteCopy")}
        </button>
        <button
          onClick={() => onCopyLink(invite.code)}
          className="settings-btn settings-btn-secondary"
          style={{ height: 28, padding: "0 10px", fontSize: 13 }}
          title={getInviteUrl(invite.code)}
        >
          {t("inviteCopyLink")}
        </button>
        <button
          onClick={() => onDelete(invite.code)}
          className="settings-btn settings-btn-danger"
          style={{ height: 28, padding: "0 10px", fontSize: 13 }}
        >
          {t("inviteDelete")}
        </button>
      </div>
    </div>
  );
}

export default InviteSettings;
