/**
 * InviteJoinPage — Handles `/invite/:code` route.
 * Redirects unauthenticated users to login, shows server preview, joins on click.
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { resolveAssetUrl, publicAsset } from "../../utils/constants";
import { getInvitePreview, type InvitePreview } from "../../api/invites";
import * as serversApi from "../../api/servers";
import Avatar from "../shared/Avatar";

function InviteJoinPage() {
  const { t } = useTranslation("servers");
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const addToast = useToastStore((s) => s.addToast);

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  // Fetch preview (works without auth)
  useEffect(() => {
    if (!code) return;
    let cancelled = false;

    async function load() {
      const res = await getInvitePreview(code!);
      if (cancelled) return;
      if (res.success && res.data) {
        setPreview(res.data);
      }
      setPreviewLoaded(true);
    }
    load();
    return () => { cancelled = true; };
  }, [code]);

  // Redirect unauthenticated users (must be after all hooks per React rules)
  if (!user) {
    return <Navigate to={`/login?returnUrl=/invite/${code ?? ""}`} replace />;
  }

  async function handleJoin() {
    if (!code || isJoining) return;
    setIsJoining(true);

    const res = await serversApi.joinServer(code);
    if (res.success && res.data) {
      const server = res.data;
      const store = useServerStore.getState();
      const exists = store.servers.some((s) => s.id === server.id);
      if (!exists) {
        useServerStore.setState((state) => ({
          servers: [...state.servers, { id: server.id, name: server.name, icon_url: server.icon_url }],
        }));
      }
      useServerStore.setState({ activeServerId: server.id, activeServer: server });
      addToast("success", t("serverJoined"));
      navigate("/channels", { replace: true });
    } else {
      const err = res.error ?? "";
      if (err.includes("already a member")) {
        addToast("info", t("alreadyMember"));
        navigate("/channels", { replace: true });
      } else {
        addToast("error", t("inviteExpired"));
      }
    }
    setIsJoining(false);
  }

  return (
    <div className="invite-join-page">
      {/* Logo + Title */}
      <div className="invite-join-header">
        <img
          src={publicAsset("mqvi-icon.svg")}
          alt="mqvi"
          className="invite-join-logo"
        />
        <h1 className="invite-join-title">{t("inviteJoinTitle")}</h1>
      </div>

      {/* Preview Card */}
      <div className="invite-join-card">
        {!previewLoaded ? (
          /* Loading skeleton */
          <div className="invite-join-loading">
            <div className="invite-join-skeleton-icon" />
            <div className="invite-join-skeleton-line" />
            <div className="invite-join-skeleton-line short" />
          </div>
        ) : preview ? (
          /* Server info */
          <>
            <div className="invite-join-server">
              <div className="invite-join-icon">
                {preview.server_icon_url ? (
                  <img
                    src={resolveAssetUrl(preview.server_icon_url)}
                    alt={preview.server_name}
                    className="invite-join-img"
                  />
                ) : (
                  <Avatar name={preview.server_name} size={56} isCircle={false} />
                )}
              </div>
              <div className="invite-join-info">
                <span className="invite-join-name">{preview.server_name}</span>
                <span className="invite-join-meta">
                  <span className="invite-join-dot" />
                  {t("memberCount", { count: preview.member_count })}
                </span>
              </div>
            </div>
            <button
              className="invite-join-btn"
              onClick={handleJoin}
              disabled={isJoining}
            >
              {isJoining ? t("joining") : t("joinInvite")}
            </button>
          </>
        ) : (
          /* Invalid invite */
          <div className="invite-join-invalid">
            <svg className="invite-join-invalid-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <p className="invite-join-error">{t("inviteExpired")}</p>
            <button
              className="invite-join-btn-secondary"
              onClick={() => navigate("/channels", { replace: true })}
            >
              {t("backToApp")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default InviteJoinPage;
