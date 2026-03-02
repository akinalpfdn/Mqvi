/**
 * InviteCard — Mesaj içindeki `mqvi:invite/{code}` kalıbını
 * tıklanabilir kart olarak render eder.
 *
 * Tıklanınca serverStore.joinServer(code) çağrılır.
 * Zaten üye ise veya geçersiz kod ise hata toast'u gösterilir.
 *
 * CSS class'ları: .invite-card, .invite-card-icon, .invite-card-info,
 * .invite-card-label, .invite-card-code, .invite-card-btn
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";

type InviteCardProps = {
  code: string;
};

function InviteCard({ code }: InviteCardProps) {
  const { t } = useTranslation("servers");
  const joinServer = useServerStore((s) => s.joinServer);
  const addToast = useToastStore((s) => s.addToast);
  const [isJoining, setIsJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  async function handleJoin() {
    if (isJoining || joined) return;
    setIsJoining(true);

    const server = await joinServer(code);
    if (server) {
      addToast("success", t("serverJoined"));
      setJoined(true);
    } else {
      // joinServer null döndüğünde — zaten üye veya geçersiz kod olabilir
      addToast("error", t("inviteExpired"));
    }
    setIsJoining(false);
  }

  return (
    <span className="invite-card" onClick={(e) => e.stopPropagation()}>
      <span className="invite-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={18} height={18}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
        </svg>
      </span>
      <span className="invite-card-info">
        <span className="invite-card-label">{t("inviteFriends")}</span>
        <span className="invite-card-code">{code}</span>
      </span>
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
