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
    // Without its files a retry sends the text alone — nothing to send when there is no text.
    const canRetry = !pending.filesLost || pending.content.trim() !== "";
    return (
      <div className="msg-pending-failed" role="alert">
        <span className="msg-pending-failed-text">
          {t(pending.filesLost ? "messageAttachmentsLost" : "messageNotSent")}
        </span>
        {canRetry && (
          <button type="button" className="msg-pending-action" onClick={() => retryPending(pending.nonce)}>
            {t("retrySend")}
          </button>
        )}
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

  // A text send in flight: the clock on the message line says it.
  return null;
}

export default PendingMessageStatus;
