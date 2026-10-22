/**
 * What the composer keeps once a message has gone out. People keep typing after Enter, so the
 * box can hold the sent text plus the start of the next message; only the part typed after the
 * send stays. A box whose sent part was itself changed during the send is left as it is —
 * guessing which part was sent could throw away the user's edit.
 */
export function textLeftAfterSend(current: string, sent: string): string {
  if (current === sent) return "";
  if (!current.startsWith(sent)) return current;
  return current.slice(sent.length).replace(/^\s+/, "");
}
