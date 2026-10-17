/**
 * Keeps the guide's ticks live: when the user does something a step counts, the guide asks the
 * server again (the server stays the only judge of what is done). Messages and DMs are reported
 * from their WebSocket handlers; everything else is watched here.
 */

import { useEffect } from "react";

import { useAuthStore } from "../stores/authStore";
import { useFriendStore } from "../stores/friendStore";
import { useGuideStore } from "../stores/guideStore";
import { useRoleStore } from "../stores/roleStore";
import { useServerStore } from "../stores/serverStore";
import { useVoiceStore } from "../stores/voiceStore";

export function useGuideProgress(): void {
  useEffect(() => {
    const refresh = useGuideStore.getState().refreshFor;
    const unsubscribers = [
      useServerStore.subscribe((s, prev) => {
        if (s.servers.length > prev.servers.length) refresh("community");
      }),
      useFriendStore.subscribe((s, prev) => {
        if (s.outgoing.length > prev.outgoing.length || s.friends.length > prev.friends.length) refresh("friend");
      }),
      useVoiceStore.subscribe((s, prev) => {
        if (s.currentVoiceChannelId && s.currentVoiceChannelId !== prev.currentVoiceChannelId) refresh("voice");
      }),
      useAuthStore.subscribe((s, prev) => {
        if (s.user?.avatar_url && s.user.avatar_url !== prev.user?.avatar_url) refresh("profile");
      }),
      // Roles change in every server the user is in (and are refetched on each server switch);
      // only a change in a server they own can be their step.
      useRoleStore.subscribe((s, prev) => {
        if (s.rolesByServer === prev.rolesByServer) return;
        const me = useAuthStore.getState().user?.id;
        const owned = new Set(useServerStore.getState().servers.filter((sv) => sv.owner_id === me).map((sv) => sv.id));
        const changed = Object.keys(s.rolesByServer).some((id) => owned.has(id) && s.rolesByServer[id] !== prev.rolesByServer[id]);
        if (changed) refresh("roles");
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);
}
