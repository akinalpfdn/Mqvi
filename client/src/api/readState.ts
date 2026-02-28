/**
 * Read State API — Okunmamış mesaj takibi endpoint'leri.
 *
 * Multi-server: server-scoped unread counts.
 * markRead: Bir kanalı belirli bir mesaja kadar okunmuş olarak işaretler.
 * getUnreadCounts: Kullanıcının belirli sunucudaki okunmamış mesaj sayılarını döner.
 */

import { apiClient } from "./client";

/** UnreadInfo — Backend'den dönen okunmamış bilgisi */
export type UnreadInfo = {
  channel_id: string;
  unread_count: number;
};

/**
 * markRead — Bir kanalı belirli bir mesaja kadar okunmuş olarak işaretler.
 *
 * Frontend kanal değiştirdiğinde veya yeni mesaj geldiğinde (aktif kanaldaysa)
 * otomatik çağrılır.
 */
export function markRead(serverId: string, channelId: string, messageId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/channels/${channelId}/read`, {
    method: "POST",
    body: { message_id: messageId },
  });
}

/**
 * getUnreadCounts — Kullanıcının belirli sunucudaki okunmamış mesaj sayılarını döner.
 *
 * Uygulama başlatıldığında ve WS reconnect'te çağrılır.
 * Sadece okunmamış > 0 olan kanallar döner (gereksiz veri yok).
 */
export function getUnreadCounts(serverId: string) {
  return apiClient<UnreadInfo[]>(`/servers/${serverId}/channels/unread`);
}
