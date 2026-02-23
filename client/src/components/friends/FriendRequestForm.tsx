/**
 * FriendRequestForm — Username ile arkadaşlık isteği gönderme formu.
 *
 * Basit bir input + submit butonu.
 * Sonuç (başarı/hata) kullanıcıya inline gösterilir.
 *
 * CSS class'ları: .frf-form, .frf-input, .frf-btn, .frf-result, .frf-success, .frf-error
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFriendStore } from "../../stores/friendStore";

function FriendRequestForm() {
  const { t } = useTranslation("common");
  const [username, setUsername] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const sendRequest = useFriendStore((s) => s.sendRequest);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    setResult(null);

    const res = await sendRequest(trimmed);

    if (res.success) {
      setResult({ success: true, message: t("friendRequestSent", { username: trimmed }) });
      setUsername("");
    } else {
      setResult({ success: false, message: res.error ?? t("somethingWentWrong") });
    }

    setIsSubmitting(false);
  }

  return (
    <div className="frf-container">
      <h3 className="frf-title">{t("addFriend")}</h3>
      <p className="frf-desc">{t("addFriendDesc")}</p>

      <form className="frf-form" onSubmit={handleSubmit}>
        <input
          className="frf-input"
          type="text"
          placeholder={t("addFriendPlaceholder")}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={isSubmitting}
          autoFocus
        />
        <button
          className="frf-btn"
          type="submit"
          disabled={isSubmitting || username.trim().length === 0}
        >
          {isSubmitting ? t("loading") : t("friendSendRequest")}
        </button>
      </form>

      {result && (
        <div className={`frf-result ${result.success ? "frf-success" : "frf-error"}`}>
          {result.message}
        </div>
      )}
    </div>
  );
}

export default FriendRequestForm;
