import { useTranslation } from "react-i18next";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useBackHandler } from "../../hooks/useBackHandler";

type SettingsDetailBackProps = {
  onBack: () => void;
  /** Falls back to a plain "Back" when the selection has no name worth showing. */
  label?: string | null;
};

/**
 * The way out of a settings detail pane on mobile, where the master and the detail cannot
 * share the screen. Renders nothing on desktop, which shows both at once.
 */
function SettingsDetailBack({ onBack, label }: SettingsDetailBackProps) {
  const { t } = useTranslation("common");
  const isMobile = useIsMobile();

  useBackHandler(onBack, isMobile);

  if (!isMobile) return null;

  return (
    <button type="button" className="settings-detail-back" onClick={onBack}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span>{label || t("back")}</span>
    </button>
  );
}

export default SettingsDetailBack;
