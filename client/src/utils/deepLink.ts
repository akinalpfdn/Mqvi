/**
 * Deep links — maps an incoming mqvi.net link onto an in-app route.
 */

const APP_LINK_HOST = "mqvi.net";
const INVITE_PREFIX = "/invite/";
const CHANNELS_PATH = "/channels";

/**
 * The route an external link should open, or null if the app cannot handle it.
 *
 * The URL comes from outside the app, so none of it is trusted: https only, our host only, and
 * only the two routes the Android manifest claims. Everything else — the landing page, login,
 * the legal pages — belongs to the browser, and anything stranger than that (a javascript: URL,
 * someone else's host) must not reach the router at all.
 */
export function deepLinkPath(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.hostname.toLowerCase() !== APP_LINK_HOST) return null;

  const path = url.pathname;
  const isInvite = path.startsWith(INVITE_PREFIX) && path.length > INVITE_PREFIX.length;
  const isChannel = path === CHANNELS_PATH || path.startsWith(CHANNELS_PATH + "/");
  if (!isInvite && !isChannel) return null;

  return path + url.search;
}
