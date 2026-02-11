/**
 * MemberList — Sağ panel: online/offline kullanıcılar.
 *
 * Discord'ta sağ bar:
 * - Rol bazlı gruplar (ONLINE — 3, OFFLINE — 1)
 * - Her kullanıcıda avatar, isim, status, custom status
 * - Kullanıcıya tıklayınca popover açılır
 *
 * Faz 2/5'te gerçek üye listesi gelecek.
 *
 * i18n: "common" namespace'ini kullanır (Online, Offline gibi genel kelimeler).
 */

import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";

function MemberList() {
  const { t } = useTranslation("common");
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex h-full w-[240px] flex-col bg-background-secondary">
      <div className="flex-1 overflow-y-auto px-2 pt-4">
        {/* Online group */}
        <h3 className="mb-1 px-2 text-xs font-semibold uppercase text-text-muted">
          {t("online")} — 1
        </h3>

        {/* Current user */}
        {user && (
          <button className="flex w-full items-center gap-3 rounded px-2 py-1.5 hover:bg-surface-hover">
            <div className="relative">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
                {user.username.charAt(0).toUpperCase()}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background-secondary bg-status-online" />
            </div>
            <span className="truncate text-sm font-medium text-text-secondary">
              {user.display_name ?? user.username}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

export default MemberList;
