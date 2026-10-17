/**
 * UnsavedChangesBar — appears only while there are unsaved changes, pinned to the top of the
 * settings pane so it is seen however far down the change was made (or however small the screen).
 */

import { useTranslation } from "react-i18next";

type UnsavedChangesBarProps = {
  hasChanges: boolean;
  isSaving?: boolean;
  /** Changes the user may not save (no permission): the bar still says so, the button is off. */
  canSave?: boolean;
  onSave: () => void;
};

function UnsavedChangesBar({ hasChanges, isSaving = false, canSave = true, onSave }: UnsavedChangesBarProps) {
  const { t } = useTranslation("settings");

  if (!hasChanges && !isSaving) return null;

  return (
    <div className="unsaved-bar" role="status">
      <span className="unsaved-bar-text">{t("unsavedChanges")}</span>
      <button type="button" className="settings-btn" onClick={onSave} disabled={isSaving || !canSave}>
        {isSaving ? t("saveChanges") + "..." : t("saveChanges")}
      </button>
    </div>
  );
}

export default UnsavedChangesBar;
