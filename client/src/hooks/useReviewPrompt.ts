/**
 * useReviewPrompt — asks the iOS / Android app user for a store review on the 10th open of an
 * app version (utils/reviewPrompt.ts), a few seconds in, and never during a call or a voice
 * channel; busy then, it tries on the next open. The OS decides whether its sheet actually
 * appears (iOS shows it at most three times a year) and does not say, so this asks once.
 */

import { useEffect } from "react";
import { App } from "@capacitor/app";
import { AppReview } from "@capawesome/capacitor-app-review";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useVoiceStore } from "../stores/voiceStore";
import { isCapacitor } from "../utils/constants";
import { recordBackground, recordForeground, shouldAskForReview, type ReviewRecord } from "../utils/reviewPrompt";

const STORAGE_KEY = "mqvi_review";
/** Lets the app finish loading before the sheet slides over it. */
export const REVIEW_DELAY_MS = 5000;

function load(): ReviewRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ReviewRecord) : null; // written only by save() below
  } catch {
    return null;
  }
}

function save(record: ReviewRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // storage blocked: the count restarts, so the request comes later or not at all
  }
}

function isBusy(): boolean {
  const call = useP2PCallStore.getState();
  return !!useVoiceStore.getState().currentVoiceChannelId || !!call.activeCall || !!call.incomingCall;
}

export function useReviewPrompt(): void {
  useEffect(() => {
    if (!isCapacitor()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const askLater = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const record = load();
        if (!active || !record || !shouldAskForReview(record, isBusy())) return;
        save({ ...record, asked: true }); // before asking: a failing request must not loop
        AppReview.requestReview().catch(() => {
          // No review API (iOS < 14) or the store is missing; this version does not ask again.
        });
      }, REVIEW_DELAY_MS);
    };

    const arrived = async () => {
      const { version } = await App.getInfo();
      if (!active) return;
      const record = recordForeground(load(), version, Date.now());
      save(record);
      if (shouldAskForReview(record, false)) askLater();
    };

    void arrived().catch(() => {
      // App.getInfo failed: nothing counted this time
    });
    const handles = [
      App.addListener("resume", () => void arrived().catch(() => {})),
      App.addListener("pause", () => {
        clearTimeout(timer);
        const record = load();
        if (record) save(recordBackground(record, Date.now()));
      }),
    ];

    return () => {
      active = false;
      clearTimeout(timer);
      handles.forEach((h) => void h.then((handle) => handle.remove()));
    };
  }, []);
}
