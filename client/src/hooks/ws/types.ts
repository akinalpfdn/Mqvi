/**
 * Shared types for WS event handler modules.
 */

import type { WSMessage } from "../../types";

/**
 * Context passed to WS event handlers.
 * Contains send functions that require the active WebSocket reference.
 */
export type WSHandlerContext = {
  sendVoiceJoin: (channelId: string) => void;
};

/** WS event handler signature */
export type WSEventHandler = (
  msg: WSMessage,
  ctx: WSHandlerContext
) => void | Promise<void>;
