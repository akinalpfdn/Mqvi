/**
 * GuideSpotlight — walks the user through a guide tour. It dims the app around the deepest
 * control of the tour that is on screen and says what to do with it; as the user opens things
 * the next control appears and the spotlight moves on. The control stays fully usable: the dim
 * is four panels around it, never over it.
 *
 * A tour may then introduce a few controls (the voice panel) with Next / Skip, clicking nothing.
 * The tour ends on its last control (or last introduction), the step getting done before that,
 * a tap on the dim, Skip, or Escape.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useGuideStore } from "../../stores/guideStore";
import { useSpotlightStore } from "../../stores/spotlightStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { SIDEBAR, currentStage, isTargetOnScreen, type TourStage } from "../../utils/guideTours";

/** How long the tour may have nothing on screen (a drawer sliding, a dialog opening). */
export const SPOTLIGHT_WAIT_MS = 1500;
/** Joining voice takes a moment before its panel exists. */
export const EXPLAIN_WAIT_MS = 10000;
const PAD = 4;
const CAPTION_GAP = 12;
const CAPTION_WIDTH = 260;
const EDGE = 8;

type Hole = { top: number; left: number; width: number; height: number };

/**
 * Where the caption goes, without knowing its height: beside the target when there is room,
 * otherwise above or below it. A target in the lower half anchors the caption by its bottom edge
 * so it grows upwards; one in the upper half anchors it by its top. Either way it stays on screen.
 */
export function captionPosition(hole: Hole, vw: number, vh: number): React.CSSProperties {
  const lowerHalf = hole.top + hole.height / 2 > vh / 2;
  const fitsRight = hole.left + hole.width + CAPTION_GAP + CAPTION_WIDTH <= vw - EDGE;
  if (fitsRight) {
    const left = hole.left + hole.width + CAPTION_GAP;
    return lowerHalf
      ? { left, bottom: Math.max(EDGE, vh - (hole.top + hole.height)) }
      : { left, top: Math.max(EDGE, hole.top) };
  }
  const left = Math.max(EDGE, Math.min(hole.left, vw - CAPTION_WIDTH - EDGE));
  return lowerHalf
    ? { left, bottom: Math.max(EDGE, vh - hole.top + CAPTION_GAP) }
    : { left, top: Math.min(vh - EDGE, hole.top + hole.height + CAPTION_GAP) };
}

type Shown = { stage: TourStage; element: HTMLElement; rect: DOMRect };

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

function GuideSpotlight() {
  const { t } = useTranslation("guide");
  const tour = useSpotlightStore((s) => s.tour);
  const close = useSpotlightStore((s) => s.close);
  const stepDone = useGuideStore((s) => (tour ? !!s.steps?.[tour.step] : false));
  const [shown, setShown] = useState<Shown | null>(null);
  /** Which introduction is up; null while still walking to the control. */
  const [explainAt, setExplainAt] = useState<number | null>(null);

  const explain = tour?.explain;
  useEffect(() => {
    setExplainAt(tour && tour.stages.length === 0 && tour.explain?.length ? 0 : null);
  }, [tour]);

  // While introducing, the drawer or sidebar holding the panel comes first if it is closed.
  const stages = useMemo<readonly TourStage[]>(() => {
    if (!tour) return [];
    if (explainAt === null || !explain) return tour.stages;
    return [...SIDEBAR, { target: explain[explainAt] }];
  }, [tour, explain, explainAt]);

  const advance = useCallback(() => {
    if (!explain || explainAt === null) return;
    if (explainAt + 1 >= explain.length) close();
    else setExplainAt(explainAt + 1);
  }, [explain, explainAt, close]);

  // Follow the deepest control on screen, every frame.
  useEffect(() => {
    setShown(null);
    if (!tour || stages.length === 0) return;
    const wait = explainAt === null ? SPOTLIGHT_WAIT_MS : EXPLAIN_WAIT_MS;
    let frame = 0;
    let current: Shown | null = null;
    let missingSince: number | null = null;

    const tick = (now: number) => {
      // The introductions are about being in voice: they wait for the connection, not for the
      // buttons — microphone and headphones are on screen in voice or not.
      const waitingForVoice = explainAt !== null && !useVoiceStore.getState().currentVoiceChannelId;
      // An introduction whose control this user does not have (no soundboard permission):
      // the panel is there, the control is not — pass over it.
      if (!waitingForVoice && explainAt !== null && explain && isTargetOnScreen("voice-panel") && !isTargetOnScreen(explain[explainAt])) {
        advance();
        return;
      }
      const hit = waitingForVoice ? null : currentStage(stages);
      if (!hit) {
        missingSince ??= now;
        if (now - missingSince > wait) {
          close();
          return;
        }
        if (current) {
          current = null;
          setShown(null);
        }
      } else {
        missingSince = null;
        const rect = hit.element.getBoundingClientRect();
        if (!current || current.element !== hit.element || !sameRect(current.rect, rect)) {
          current = { ...hit, rect };
          setShown(current);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [tour, stages, explain, explainAt, advance, close]);

  // Using the last control ends the walk (or starts the introductions); Escape ends it all.
  useEffect(() => {
    if (!shown || !tour) return;
    const onPointerDown = (e: PointerEvent) => {
      if (explainAt !== null || !shown.stage.final) return;
      if (!(e.target instanceof Node) || !shown.element.contains(e.target)) return;
      if (tour.explain?.length) setExplainAt(0);
      else close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [shown, tour, explainAt, close]);

  // Done some other way: nothing left to walk to — but the introductions still have a point.
  useEffect(() => {
    if (!stepDone || !tour || explainAt !== null) return;
    if (tour.explain?.length) setExplainAt(0);
    else close();
  }, [stepDone, tour, explainAt, close]);

  if (!tour || !shown) return null;

  const { rect } = shown;
  const hole = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
  const caption = captionPosition(hole, window.innerWidth, window.innerHeight);
  const target = shown.stage.target;
  const introducing = explainAt !== null && explain?.[explainAt] === target;
  const isLast = !!explain && explainAt === explain.length - 1;

  return createPortal(
    <div className="guide-spot" role="dialog" aria-live="polite">
      <div className="guide-spot-dim" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} onPointerDown={close} />
      <div className="guide-spot-ring" style={hole} />
      <div className={`guide-spot-caption${introducing ? " interactive" : ""}`} style={caption}>
        <div>{t([`spotlight.${tour.scope}.${target}`, `spotlight.stage.${target}`])}</div>
        {introducing && explain && explainAt !== null && (
          <div className="guide-spot-actions">
            <span className="guide-spot-count">
              {explainAt + 1}/{explain.length}
            </span>
            <button type="button" className="guide-spot-skip" onClick={close}>
              {t("tourSkip")}
            </button>
            <button type="button" className="guide-spot-next" onClick={advance}>
              {t(isLast ? "tourDone" : "tourNext")}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default GuideSpotlight;
