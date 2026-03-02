/**
 * PlatformActionDialog — Platform admin aksiyonları için yeniden kullanılabilir onay dialogu.
 *
 * Server delete ve user delete gibi aksiyonlarda kullanılır.
 * Opsiyonel reason textarea içerir — reason doldurulursa ilgili kişiye
 * email bildirim gönderilir (backend tarafında).
 *
 * PlatformBanDialog'dan farkı: "mesajları da sil" checkbox'u yok.
 * Sadece reason + confirm/cancel.
 *
 * Props:
 * - title: Dialog başlığı
 * - description: Açıklama metni
 * - reasonLabel: Textarea label'ı
 * - reasonPlaceholder: Textarea placeholder'ı
 * - confirmLabel: Onay butonu metni
 * - onConfirm: Onaylandığında reason ile çağrılır
 * - onCancel: İptal edildiğinde çağrılır
 */

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type PlatformActionDialogProps = {
  title: string;
  description: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

function PlatformActionDialog({
  title,
  description,
  reasonLabel,
  reasonPlaceholder,
  confirmLabel,
  onConfirm,
  onCancel,
}: PlatformActionDialogProps) {
  const { t } = useTranslation("settings");
  const [reason, setReason] = useState("");
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
    onConfirm(reason.trim());
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card platform-action-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
        </div>
        <p className="modal-text">{description}</p>

        <form onSubmit={handleSubmit}>
          {/* Opsiyonel reason */}
          <label className="platform-ban-label">
            {reasonLabel}
          </label>
          <textarea
            ref={textareaRef}
            className="platform-ban-textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder}
            rows={3}
            maxLength={500}
          />

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
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export default PlatformActionDialog;
