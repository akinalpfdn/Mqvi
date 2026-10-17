/**
 * GuideSpotlight — walks the user through a guide tour. It dims the app around the deepest
 * control of the tour that is on screen and says what to do with it; as the user opens things
 * the next control appears and the spotlight moves on. The control stays fully usable: the dim
 * is four panels around it, never over it. Using the final control, the step getting done, a
 * tap on the dim, or Escape ends the tour.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useGuideStore } from "../../stores/guideStore";
import { useSpotlightStore } from "../../stores/spotlightStore";
import { currentStage, type TourStage } from "../../utils/guideTours";

/** How long the tour may have nothing on screen (a drawer sliding, a dialog opening). */
export const SPOTLIGHT_WAIT_MS = 1500;
const PAD = 4;
const CAPTION_GAP = 12;
const CAPTION_WIDTH = 260;
const CAPTION_HEIGHT_GUESS = 80;

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

  // Follow the deepest control on screen, every frame.
  useEffect(() => {
    setShown(null);
    if (!tour) return;
    let frame = 0;
    let current: Shown | null = null;
    let missingSince: number | null = null;

    const tick = (now: number) => {
      const hit = currentStage(tour.stages);
      if (!hit) {
        missingSince ??= now;
        if (now - missingSince > SPOTLIGHT_WAIT_MS) {
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
  }, [tour, close]);

  // Using the final control or Escape ends it; using an earlier one just lets the tour move on.
  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (e: PointerEvent) => {
      if (shown.stage.final && e.target instanceof Node && shown.element.contains(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [shown, close]);

  useEffect(() => {
    if (stepDone) close();
  }, [stepDone, close]);

  if (!tour || !shown) return null;

  const { rect } = shown;
  const hole = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fitsRight = hole.left + hole.width + CAPTION_GAP + CAPTION_WIDTH <= vw - 8;
  const below = hole.top + hole.height + CAPTION_GAP;
  const caption = fitsRight
    ? { top: Math.max(8, Math.min(hole.top, vh - CAPTION_HEIGHT_GUESS - 8)), left: hole.left + hole.width + CAPTION_GAP }
    : {
        top: below + CAPTION_HEIGHT_GUESS < vh ? below : Math.max(8, hole.top - CAPTION_GAP - CAPTION_HEIGHT_GUESS),
        left: Math.max(8, Math.min(hole.left, vw - CAPTION_WIDTH - 8)),
      };
  const target = shown.stage.target;

  return createPortal(
    <div className="guide-spot" role="dialog" aria-live="polite">
      <div className="guide-spot-dim" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} onPointerDown={close} />
      <div className="guide-spot-ring" style={hole} />
      <div className="guide-spot-caption" style={caption}>
        {t([`spotlight.${tour.scope}.${target}`, `spotlight.stage.${target}`])}
      </div>
    </div>,
    document.body,
  );
}

export default GuideSpotlight;
