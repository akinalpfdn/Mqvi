/**
 * PlatformBanDialog — Platform-level ban onay diyalogu.
 *
 * useConfirm yetmez — textarea (ban reason) + checkbox (mesaj silme)
 * gerektirdiğinden custom modal. Mevcut .modal-backdrop / .modal-card
 * CSS class'ları kullanılır.
 *
 * Props:
 * - username: Banlanan kullanıcının adı (dialog'da gösterilir)
 * - onConfirm: Onaylandığında reason + deleteMessages ile çağrılır
 * - onCancel: İptal edildiğinde çağrılır
 */

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type PlatformBanDialogProps = {
  username: string;
  onConfirm: (reason: string, deleteMessages: boolean) => void;
  onCancel: () => void;
};

function PlatformBanDialog({ username, onConfirm, onCancel }: PlatformBanDialogProps) {
  const { t } = useTranslation("settings");
  const [reason, setReason] = useState("");
  const [deleteMessages, setDeleteMessages] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Dialog açılınca textarea'ya focus
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Escape ile kapatma
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm(reason.trim(), deleteMessages);
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card platform-ban-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{t("platformBanTitle")}</h2>
        </div>
        <p className="modal-text">
          {t("platformBanDescription", { username })}
        </p>

        <form onSubmit={handleSubmit}>
          {/* Ban reason */}
          <label className="platform-ban-label">
            {t("platformBanReasonLabel")}
          </label>
          <textarea
            ref={textareaRef}
            className="platform-ban-textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("platformBanReasonPlaceholder")}
            rows={3}
            maxLength={500}
          />

          {/* Delete messages toggle */}
          <label className="platform-ban-checkbox-label">
            <input
              type="checkbox"
              checked={deleteMessages}
              onChange={(e) => setDeleteMessages(e.target.checked)}
            />
            <span>{t("platformBanDeleteMessages")}</span>
          </label>

          {/* Actions */}
          <div className="modal-actions">
            <button
              type="button"
              className="settings-btn settings-btn-secondary"
              onClick={onCancel}
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              className="settings-btn settings-btn-danger"
            >
              {t("platformBanConfirm")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export default PlatformBanDialog;
