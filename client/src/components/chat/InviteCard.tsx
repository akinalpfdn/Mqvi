/**
 * InviteCard — Mesaj içindeki `mqvi:invite/{code}` kalıbını
 * zengin kart olarak render eder.
 *
 * Mount'ta invite preview API'den sunucu bilgisi çekilir:
 * - Sunucu adı, ikonu, üye sayısı gösterilir
 * - Geçersiz kod ise fallback görünüm
 *
 * Tıklanınca: API join endpoint'i çağrılır, hata mesajı parse edilerek
 * "already a member" ve "expired/invalid" ayrı ayrı gösterilir.
 *
 * CSS class'ları: .invite-card, .invite-card-icon, .invite-card-info,
 * .invite-card-name, .invite-card-meta, .invite-card-btn
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { resolveAssetUrl } from "../../utils/constants";
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

  /** Preview verisi — null ise henüz yüklenmedi veya geçersiz kod */
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  // Mount'ta preview bilgisini çek
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

  async function handleJoin() {
    if (isJoining || joined) return;
    setIsJoining(true);

    // Doğrudan API çağır — hata mesajını parse edebilmek için
    const res = await serversApi.joinServer(code);
    if (res.success && res.data) {
      // Store'u da güncelle
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
      setJoined(true);
    } else {
      // Hata mesajını parse et — backend spesifik mesajlar döndürüyor
      const err = res.error ?? "";
      if (err.includes("already a member")) {
        addToast("info", t("alreadyMember"));
      } else {
        addToast("error", t("inviteExpired"));
      }
    }
    setIsJoining(false);
  }

  // Preview yüklenene kadar minimal skeleton
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
      {/* Sunucu ikonu */}
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

      {/* Sunucu bilgisi */}
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

      {/* Katıl butonu */}
      <button
        className="invite-card-btn"
        onClick={handleJoin}
        disabled={isJoining || joined}
      >
        {joined ? "\u2713" : isJoining ? "..." : t("joinInvite")}
      </button>
    </span>
  );
}

export default InviteCard;
