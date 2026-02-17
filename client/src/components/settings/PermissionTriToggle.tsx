/**
 * PermissionTriToggle — Kanal permission override için üçlü durum toggle'ı.
 *
 * Discord tarzı 3 ayrı buton gösterir:
 * - ✕ (Deny — kırmızı)
 * - — (Inherit — gri/nötr)
 * - ✓ (Allow — yeşil)
 *
 * Aktif buton renkli vurgulanır, diğerleri soluk kalır.
 * Bu sayede kullanıcı mevcut durumu ve tüm seçenekleri tek bakışta görür.
 *
 * CSS class'ları: .perm-tri, .perm-tri-info, .perm-tri-label, .perm-tri-desc,
 * .perm-tri-controls, .perm-tri-btn, .perm-tri-btn.active.deny/.inherit/.allow
 */

import { useTranslation } from "react-i18next";

export type TriState = "inherit" | "allow" | "deny";

type PermissionTriToggleProps = {
  permBit: number;
  labelKey: string;
  descKey: string;
  state: TriState;
  onChange: (permBit: number, newState: TriState) => void;
};

function PermissionTriToggle({
  permBit,
  labelKey,
  descKey,
  state,
  onChange,
}: PermissionTriToggleProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="perm-tri">
      {/* Label + Description — sol tarafta */}
      <div className="perm-tri-info">
        <p className="perm-tri-label">{t(labelKey)}</p>
        <p className="perm-tri-desc">{t(descKey)}</p>
      </div>

      {/* 3 ayrı durum butonu — sağ tarafta */}
      <div className="perm-tri-controls">
        {/* Deny (✕) */}
        <button
          className={`perm-tri-btn deny${state === "deny" ? " active" : ""}`}
          onClick={() => onChange(permBit, state === "deny" ? "inherit" : "deny")}
          title={t("permOverrideDeny")}
        >
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Inherit (—) */}
        <button
          className={`perm-tri-btn inherit${state === "inherit" ? " active" : ""}`}
          onClick={() => onChange(permBit, "inherit")}
          title={t("permOverrideInherit")}
        >
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" d="M6 12h12" />
          </svg>
        </button>

        {/* Allow (✓) */}
        <button
          className={`perm-tri-btn allow${state === "allow" ? " active" : ""}`}
          onClick={() => onChange(permBit, state === "allow" ? "inherit" : "allow")}
          title={t("permOverrideAllow")}
        >
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default PermissionTriToggle;
