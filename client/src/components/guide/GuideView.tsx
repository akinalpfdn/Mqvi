/**
 * GuideView — the mqvi Guide conversation: a fixed script drawn on the client, revealed a line
 * at a time, then every step card together. Not a real DM: nothing here is sent anywhere.
 */

import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useAuthStore } from "../../stores/authStore";
import { useGuideStore } from "../../stores/guideStore";
import { useUIStore } from "../../stores/uiStore";
import { useGuideReveal } from "../../hooks/useGuideReveal";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { GUIDE_TAB_ID, guideConversation, type GuideItem } from "../../utils/guideScript";
import { showGuideStep } from "../../utils/guideActions";
import { publicAsset } from "../../utils/constants";
import GuideCard from "./GuideCard";
import type { GuideState } from "../../types";

const NO_PROGRESS: GuideState["steps"] = {
  community: false, message: false, dm: false, voice: false, friend: false, profile: false, roles: false, app: false,
};

/** What appears in one beat: a line, or all the step cards together. */
type GuideBeat = { id: string; items: GuideItem[] };

function toBeats(items: GuideItem[]): GuideBeat[] {
  const beats: GuideBeat[] = [];
  for (const item of items) {
    const last = beats.at(-1);
    if (item.kind === "card" && last?.id === "cards") last.items.push(item);
    else beats.push({ id: item.kind === "card" ? "cards" : item.id, items: [item] });
  }
  return beats;
}

function GuideView() {
  const { t } = useTranslation("guide");
  const user = useAuthStore((s) => s.user);
  const steps = useGuideStore((s) => s.steps);
  const setHidden = useGuideStore((s) => s.setHidden);
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLDivElement>(null);

  const beats = useMemo(() => toBeats(guideConversation(steps ?? NO_PROGRESS)), [steps]);
  const ids = useMemo(() => beats.map((beat) => beat.id), [beats]);
  const { visible, typing } = useGuideReveal(ids, user?.id ?? "anonymous");
  const name = user?.display_name || user?.username || "";

  // Keep the newest line in view as it appears.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, typing]);

  async function handleHide() {
    if (!(await setHidden(true))) return;
    const ui = useUIStore.getState();
    for (const panel of Object.values(ui.panels)) {
      const tab = panel.tabs.find((tb) => tb.channelId === GUIDE_TAB_ID);
      if (tab) ui.closeTab(panel.id, tab.id);
    }
  }

  function renderItem(item: GuideItem) {
    if (item.kind === "card") {
      return (
        <div key={item.id} className="guide-line guide-line-card">
          <GuideCard step={item.step} done={item.done} onShowMe={(step) => showGuideStep(step, isMobile)} />
        </div>
      );
    }
    return (
      <div key={item.id} className="guide-line">
        <div className="guide-bubble">{t(item.textKey, { name })}</div>
      </div>
    );
  }

  return (
    <div className="chat-area guide-view">
      <div className="dm-header">
        <img src={publicAsset("mqvi-icon-128.png")} alt="" className="guide-avatar" />
        <span className="dm-header-name">{t("name")}</span>
        <span className="guide-badge">{t("badge")}</span>
        <div className="ch-actions">
          <button type="button" onClick={handleHide} title={t("hide")} aria-label={t("hide")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="guide-scroll">
        <div className="guide-thread">
          <img src={publicAsset("mqvi-icon-128.png")} alt="" className="guide-avatar guide-avatar-lg" />
          <div className="guide-lines">
            {beats.slice(0, visible).flatMap((beat) => beat.items.map(renderItem))}
            {typing && (
              <div className="guide-line">
                <div className="guide-typing" role="status" aria-label={t("typing")}>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default GuideView;
