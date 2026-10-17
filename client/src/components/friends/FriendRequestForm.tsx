/** Send friend request by username. Shows inline success/error result. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFriendStore } from "../../stores/friendStore";

/** Server refusal codes and how to word them; anything else gets a gentle "try again". */
const REFUSALS: Record<string, string> = {
  friend_user_not_found: "friendErrorNotFound",
  friend_self: "friendErrorSelf",
  friend_already_friends: "friendErrorAlreadyFriends",
  friend_request_pending: "friendErrorPending",
  friend_invalid_username: "friendErrorInvalid",
};

function FriendRequestForm() {
  const { t } = useTranslation("common");
  const [username, setUsername] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "info"; message: string } | null>(null);

  const sendRequest = useFriendStore((s) => s.sendRequest);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    setResult(null);

    const res = await sendRequest(trimmed);

    if (res.success) {
      setResult({ tone: "success", message: t("friendRequestSent", { username: trimmed }) });
      setUsername("");
    } else {
      // Never the server's raw text: a refusal is worded kindly, anything unknown as a retry.
      const key = (res.code && REFUSALS[res.code]) || "friendErrorGeneric";
      setResult({ tone: "info", message: t(key, { username: trimmed }) });
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
          data-tour="add-friend-input"
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
        <div className={`frf-result frf-${result.tone}`} role="status">
          {result.message}
        </div>
      )}
    </div>
  );
}

export default FriendRequestForm;
