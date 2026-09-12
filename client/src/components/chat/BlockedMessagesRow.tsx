/** BlockedMessagesRow — Collapsed placeholder for a run of messages from blocked users. */

import { useTranslation } from "react-i18next";

type BlockedMessagesRowProps = {
  count: number;
  onReveal: () => void;
};

function BlockedMessagesRow({ count, onReveal }: BlockedMessagesRowProps) {
  const { t } = useTranslation("chat");

  return (
    <div className="msg-blocked-row">
      <span>{count === 1 ? t("blockedMessagesOne") : t("blockedMessagesMany", { count })}</span>
      <button type="button" onClick={onReveal}>
        {t("showBlockedMessages")}
      </button>
    </div>
  );
}

export default BlockedMessagesRow;
