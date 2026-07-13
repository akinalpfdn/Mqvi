import i18n from "../i18n";
import type { APIResponse } from "../types";

/** Password rejections arrive as a code so they can be shown in the user's language. */
const CODE_KEYS: Record<string, string> = {
  password_too_short: "auth:passwordTooShort",
  password_too_long: "auth:passwordTooLong",
  password_contains_identity: "auth:passwordContainsIdentity",
  password_breached: "auth:passwordBreached",
};

export function passwordErrorKey(code?: string): string | null {
  return (code && CODE_KEYS[code]) ?? null;
}

/** A failure that isn't about the password keeps the server's own message. */
export function passwordErrorMessage(res: APIResponse<unknown>, fallbackKey: string): string {
  const key = passwordErrorKey(res.code);
  if (key) return i18n.t(key);
  return res.error ?? i18n.t(fallbackKey);
}
