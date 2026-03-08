/** PermissionTriToggle — Tri-state toggle (Deny / Inherit / Allow) for channel permission overrides. */

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
      <div className="perm-tri-info">
        <p className="perm-tri-label">{t(labelKey)}</p>
        <p className="perm-tri-desc">{t(descKey)}</p>
      </div>

      <div className="perm-tri-controls">
        <button
          className={`perm-tri-btn deny${state === "deny" ? " active" : ""}`}
          onClick={() => onChange(permBit, state === "deny" ? "inherit" : "deny")}
          title={t("permOverrideDeny")}
        >
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <button
          className={`perm-tri-btn inherit${state === "inherit" ? " active" : ""}`}
          onClick={() => onChange(permBit, "inherit")}
          title={t("permOverrideInherit")}
        >
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" d="M6 12h12" />
          </svg>
        </button>

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
