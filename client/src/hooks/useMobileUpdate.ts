/**
 * useMobileUpdate — on the iOS and Android apps, decides whether to show the update prompt:
 * required below the server's minimum version, optional when the store has a newer one.
 * Checks at launch and whenever the app comes back to the foreground. Held back during a call
 * or a voice channel — a blocking screen there would cover the hang-up button — and shown when
 * it ends. Inert everywhere else (the desktop app has its own updater).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { AppUpdate, AppUpdateAvailability, type AppUpdateInfo } from "@capawesome/capacitor-app-update";
import { getClientPolicy } from "../api/clientPolicy";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useVoiceStore } from "../stores/voiceStore";
import { compareVersions, decideUpdate, type StoreVersion, type UpdateState } from "../utils/appUpdate";
import { getCapacitorPlatform, isCapacitor } from "../utils/constants";
import { APP_STORE_ID } from "../utils/detectOS";

const DISMISSED_KEY = "mqvi_update_dismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null; // storage blocked: the prompt may come back, nothing worse
  }
}

async function storeInfo(): Promise<AppUpdateInfo | null> {
  try {
    return await AppUpdate.getAppUpdateInfo();
  } catch {
    return null; // no store (sideloaded build) or no network: no optional prompt this time
  }
}

/**
 * The newer version the store offers, if this device can install it. Play only offers what the
 * device can run; the App Store lookup does not check, so iOS compares minimumOsVersion itself.
 */
async function installableStoreVersion(info: AppUpdateInfo | null, platform: "ios" | "android"): Promise<StoreVersion | null> {
  if (info?.updateAvailability !== AppUpdateAvailability.UPDATE_AVAILABLE) return null;
  if (platform === "android") return info.availableVersionCode ? { id: info.availableVersionCode, name: null } : null;

  const name = info.availableVersionName;
  if (!name) return null;
  if (info.minimumOsVersion) {
    try {
      const { osVersion } = await Device.getInfo();
      if (compareVersions(osVersion, info.minimumOsVersion) < 0) return null;
    } catch {
      return null; // cannot tell: offer nothing rather than an update this iPhone may not take
    }
  }
  return { id: name, name };
}

async function check(): Promise<{ state: UpdateState; info: AppUpdateInfo | null }> {
  const platform = getCapacitorPlatform() === "ios" ? "ios" : "android";
  const [appInfo, policy, info] = await Promise.all([
    App.getInfo(),
    getClientPolicy(),
    storeInfo(),
  ]);
  // A server that cannot be reached cannot demand anything.
  const minimum = policy.success && policy.data ? policy.data.min_versions[platform] : null;
  const store = await installableStoreVersion(info, platform);
  return {
    state: decideUpdate({ current: appInfo.version, minimum, store, dismissedId: readDismissed() }),
    info,
  };
}

export function useMobileUpdate() {
  const [state, setState] = useState<UpdateState>({ kind: "none" });
  const infoRef = useRef<AppUpdateInfo | null>(null);
  const inVoice = useVoiceStore((s) => !!s.currentVoiceChannelId);
  const inCall = useP2PCallStore((s) => !!s.activeCall || !!s.incomingCall);

  useEffect(() => {
    if (!isCapacitor()) return;
    let active = true;
    let latest = 0;

    const run = async () => {
      const seq = ++latest;
      try {
        const result = await check();
        if (!active || seq !== latest) return;
        infoRef.current = result.info;
        setState(result.state);
      } catch {
        // App.getInfo failing leaves nothing to compare; try again on the next resume.
      }
    };

    void run();
    const handle = App.addListener("resume", () => void run());
    return () => {
      active = false;
      void handle.then((h) => h.remove());
    };
  }, []);

  /** Android installs through Play's own update screen when it can; otherwise the store page. */
  const update = useCallback(async () => {
    const info = infoRef.current;
    try {
      if (
        getCapacitorPlatform() === "android" &&
        info?.updateAvailability === AppUpdateAvailability.UPDATE_AVAILABLE &&
        info.immediateUpdateAllowed
      ) {
        await AppUpdate.performImmediateUpdate();
        return;
      }
      await AppUpdate.openAppStore({ appId: APP_STORE_ID });
    } catch {
      // Neither opened; the prompt stays so the user can try again.
    }
  }, []);

  /** Puts off the offered version; a later store version is offered again. */
  const dismiss = useCallback(() => {
    if (state.kind !== "available") return;
    try {
      localStorage.setItem(DISMISSED_KEY, state.id);
    } catch {
      // storage blocked: dismissed for this session only
    }
    setState({ kind: "none" });
  }, [state]);

  const busy = inVoice || inCall;
  return { state: busy ? ({ kind: "none" } as const) : state, update, dismiss };
}
