/**
 * GuideBootstrap — loads the guide's state for the signed-in user and, on their very first
 * sign-in, opens the guide instead of an empty screen. Someone who arrived through an invite is
 * already in a community: their server stays in front and the guide waits in the sidebar.
 * Renders nothing.
 */

import { useEffect, useRef } from "react";

import { dismissWelcome } from "../../api/auth";
import { useAuthStore } from "../../stores/authStore";
import { useGuideStore } from "../../stores/guideStore";
import { openGuide } from "../../utils/openGuide";
import { useGuideProgress } from "../../hooks/useGuideProgress";
import { isNativeApp } from "../../utils/constants";

function GuideBootstrap() {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const openedFor = useRef<string | null>(null);
  useGuideProgress();

  const userId = user?.id;
  const firstVisit = !!user && !user.has_seen_welcome;
  const steps = useGuideStore((s) => s.steps);
  const hidden = useGuideStore((s) => s.hidden);

  useEffect(() => {
    if (!userId) return;
    const hiddenAtSignIn = !!useAuthStore.getState().user?.guide_hidden;
    useGuideStore.getState().seed(hiddenAtSignIn);
    // A hidden guide shows nothing, and reading its state is a write on the server: skip it
    // until the guide is brought back (GuideRestore loads it then).
    if (!hiddenAtSignIn) void useGuideStore.getState().load();
  }, [userId]);

  // The apps report themselves: running one is the "get the app" step.
  const appStepDone = steps?.app;
  useEffect(() => {
    if (userId && appStepDone === false && isNativeApp()) void useGuideStore.getState().markAppUsed();
  }, [userId, appStepDone]);

  useEffect(() => {
    // Wait for the server's answer: whether they already have a community decides it.
    if (!userId || !firstVisit || !steps || openedFor.current === userId) return;
    openedFor.current = userId;
    // Hidden — an account from before the guide existed, or one that put it away — stays hidden.
    if (!steps.community && !hidden) openGuide();
    // Once per account: has_seen_welcome is the server's record that the guide was introduced.
    updateUser({ has_seen_welcome: true });
    void dismissWelcome();
  }, [userId, firstVisit, steps, hidden, updateUser]);

  return null;
}

export default GuideBootstrap;
