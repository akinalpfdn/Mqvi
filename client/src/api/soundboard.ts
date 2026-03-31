/**
 * Soundboard API — per-server sound management and playback.
 */

import { apiClient } from "./client";
import type { SoundboardSound } from "../types";

export async function getSounds(serverId: string) {
  return apiClient<SoundboardSound[]>(`/servers/${serverId}/soundboard/sounds`);
}

export async function createSound(
  serverId: string,
  file: File,
  name: string,
  durationMs: number,
  emoji?: string
) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("name", name);
  formData.append("duration_ms", String(durationMs));
  if (emoji) formData.append("emoji", emoji);

  return apiClient<SoundboardSound>(`/servers/${serverId}/soundboard/sounds`, {
    method: "POST",
    body: formData,
  });
}

export async function updateSound(
  serverId: string,
  soundId: string,
  data: { name?: string; emoji?: string | null }
) {
  return apiClient<SoundboardSound>(
    `/servers/${serverId}/soundboard/sounds/${soundId}`,
    { method: "PATCH", body: data }
  );
}

export async function deleteSound(serverId: string, soundId: string) {
  return apiClient<void>(
    `/servers/${serverId}/soundboard/sounds/${soundId}`,
    { method: "DELETE" }
  );
}

export async function playSound(serverId: string, soundId: string) {
  return apiClient<void>(
    `/servers/${serverId}/soundboard/sounds/${soundId}/play`,
    { method: "POST" }
  );
}
