/** PendingMessageStatus — the delivery line under a message the server has not confirmed yet. */

import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { useOutboxStore, type PendingMessage } from "../../stores/outboxStore";
import UploadProgress from "../shared/UploadProgress";

type PendingMessageStatusProps = {
  pending: PendingMessage;
};

function PendingMessageStatus({ pending }: PendingMessageStatusProps) {
  const { t } = useTranslation("chat");
  const { retryPending, discardPending } = useChatContext();
  // Its own subscription, so an upload tick re-renders this line and nothing else.
  const progress = useOutboxStore((s) => s.progressByNonce[pending.nonce]);

  if (pending.status === "failed") {
    return (
      <div className="msg-pending-failed" role="alert">
        <span className="msg-pending-failed-text">{t("messageNotSent")}</span>
        <button type="button" className="msg-pending-action" onClick={() => retryPending(pending.nonce)}>
          {t("retrySend")}
        </button>
        <button type="button" className="msg-pending-action" onClick={() => discardPending(pending.nonce)}>
          {t("discardMessage")}
        </button>
      </div>
    );
  }

  if (progress) {
    return (
      <UploadProgress
        loaded={progress.loaded}
        total={progress.total}
        onCancel={() => discardPending(pending.nonce)}
      />
    );
  }

  // Delayed in CSS: a send that confirms quickly never shows it.
  return <span className="msg-pending-sending">{t("messageSending")}</span>;
}

export default PendingMessageStatus;
