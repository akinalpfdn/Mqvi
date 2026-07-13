import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { useConfirm } from "./useConfirm";

/**
 * Logging out drops any voice call, unregisters the push token so notifications stop, and
 * clears E2EE state — too much to hand to a stray click, and both entry points sit next to
 * something people use often.
 */
export function useLogout(): () => Promise<void> {
  const { t } = useTranslation("settings");
  const confirm = useConfirm();
  const logout = useAuthStore((s) => s.logout);

  return useCallback(async () => {
    const ok = await confirm({
      title: t("logOut"),
      message: t("logOutConfirm"),
      confirmLabel: t("logOut"),
      danger: true,
    });
    if (ok) await logout();
  }, [confirm, logout, t]);
}
