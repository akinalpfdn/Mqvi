/**
 * MemberList — Sağ panel: online/offline kullanıcılar.
 *
 * Discord referans spacing'leri:
 * - Header: h-header(48px), diğer panellerle hizalı
 * - Group başlıkları: uppercase, 24px üst padding, 8px alt
 * - Kullanıcı item'ları: 42px yükseklik, 8px padding, avatar + isim
 * - Genel: 8px iç kenar boşlukları
 */

import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";

function MemberList() {
  const { t } = useTranslation("common");
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex h-full w-member-list flex-col bg-background-secondary">
      {/* ─── Header ─── */}
      <div className="flex h-header shrink-0 items-center border-b border-background-tertiary px-4 shadow-sm">
        <h3 className="text-sm font-semibold text-text-secondary">
          {t("members")}
        </h3>
      </div>

      {/* ─── Member List ─── */}
      <div className="flex-1 overflow-y-auto px-3 pt-6">
        {/* Online group header */}
        <div className="px-2 pb-3 pt-2">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.02em] text-text-muted">
            {t("online")} — 1
          </h3>
        </div>

        {/* Current user */}
        {user && (
          <div className="px-1">
            <button className="flex h-11 w-full items-center gap-3.5 rounded-md px-2.5 transition-colors hover:bg-surface-hover">
              {/* Avatar */}
              <div className="relative shrink-0">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                  {user.username.charAt(0).toUpperCase()}
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-[2.5px] border-background-secondary bg-status-online" />
              </div>

              {/* Username */}
              <span className="truncate text-[15px] font-medium leading-5 text-text-secondary">
                {user.display_name ?? user.username}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default MemberList;
