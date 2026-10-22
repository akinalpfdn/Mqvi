/** DeliveryMark — clock while the server has not stored the sender's own message, a tick once it has. */

import { useTranslation } from "react-i18next";
import type { DeliveryState } from "../../utils/deliveryState";

function DeliveryMark({ state }: { state: DeliveryState }) {
  const { t } = useTranslation("chat");
  const label = t(state === "pending" ? "messageSending" : "messageSent");

  return (
    <span className={`msg-delivery ${state}`} role="img" aria-label={label} title={label}>
      {state === "pending" ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.8V8l2.2 1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      )}
    </span>
  );
}

export default DeliveryMark;
