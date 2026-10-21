/** Runs the on-device conversation cache for as long as a user is signed in. */

import { useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import { startConversationCache } from "../cache/conversationCache";

export function useConversationCache(): void {
  const userId = useAuthStore((s) => s.user?.id);
  useEffect(() => (userId ? startConversationCache(userId) : undefined), [userId]);
}
