/**
 * InviteJoinPage — `/invite/:code` rotasında gösterilen davet katılma sayfası.
 *
 * Akış:
 * 1. Kullanıcı giriş yapmamışsa → `/login?returnUrl=/invite/{code}` redirect
 * 2. Preview bilgisi çekilir (sunucu adı, ikon, üye sayısı)
 * 3. "Katıl" butonuna basılır → joinServer API çağrılır
 * 4. Başarılı → `/channels`'a yönlendirilir (sunucu otomatik seçilir)
 *
 * Bu sayfa dış paylaşımlar için tasarlandı — WhatsApp, Telegram vb.
 * üzerinden paylaşılan davet linklerini karşılar.
 *
 * CSS class'ları: .invite-join-page, .invite-join-card, .invite-join-icon,
 * .invite-join-name, .invite-join-meta, .invite-join-btn
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { resolveAssetUrl } from "../../utils/constants";
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

  // Preview bilgisi çek — user yoksa bile çalışır (preview endpoint auth gerektirmez)
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

  // Giriş yapmamış → login'e yönlendir (returnUrl ile)
  // Hooklar'dan SONRA return — React hooks kuralı gereği
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

  // Geçersiz kod
  if (!code) {
    return (
      <div className="invite-join-page">
        <div className="invite-join-card">
          <p className="invite-join-error">{t("inviteExpired")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="invite-join-page">
      <div className="invite-join-card">
        {!previewLoaded ? (
          /* Loading skeleton */
          <div className="invite-join-loading">
            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-surface border-t-brand" />
          </div>
        ) : preview ? (
          /* Sunucu bilgisi */
          <>
            <div className="invite-join-icon">
              {preview.server_icon_url ? (
                <img
                  src={resolveAssetUrl(preview.server_icon_url)}
                  alt={preview.server_name}
                  className="invite-join-img"
                />
              ) : (
                <Avatar name={preview.server_name} size={64} />
              )}
            </div>
            <h2 className="invite-join-name">{preview.server_name}</h2>
            <p className="invite-join-meta">
              {t("memberCount", { count: preview.member_count })}
            </p>
            <button
              className="invite-join-btn"
              onClick={handleJoin}
              disabled={isJoining}
            >
              {isJoining ? t("joining") : t("joinInvite")}
            </button>
          </>
        ) : (
          /* Geçersiz davet */
          <>
            <p className="invite-join-error">{t("inviteExpired")}</p>
            <button
              className="invite-join-btn-secondary"
              onClick={() => navigate("/channels", { replace: true })}
            >
              {t("backToApp")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default InviteJoinPage;
