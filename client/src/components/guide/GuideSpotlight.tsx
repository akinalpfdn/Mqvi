/**
 * GuideSpotlight — dims the app around one real control and says what it is for. The control
 * stays fully usable: the dim is four panels around it, never over it. Using the control,
 * tapping elsewhere, Escape, or closing the mobile drawer it lives in ends the spotlight.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useSpotlightStore } from "../../stores/spotlightStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { findTourTarget, tourCaptionKey, type TourTarget } from "../../utils/guideTargets";

/** How long to wait for a target to appear (drawer sliding in, a section expanding). */
export const SPOTLIGHT_WAIT_MS = 1500;
const PAD = 4;
const CAPTION_GAP = 12;
const CAPTION_WIDTH = 260;

type Found = { element: HTMLElement; target: TourTarget; rect: DOMRect };

function GuideSpotlight() {
  const { t } = useTranslation("guide");
  const request = useSpotlightStore((s) => s.request);
  const close = useSpotlightStore((s) => s.close);
  const drawerOpen = useMobileStore((s) => s.leftDrawerOpen);
  const isMobile = useIsMobile();
  const [found, setFound] = useState<Found | null>(null);

  // Find the target (waiting for it to appear), then follow it every frame while shown.
  useEffect(() => {
    setFound(null);
    if (!request) return;
    const started = performance.now();
    let frame = 0;
    let current: Found | null = null;

    const tick = () => {
      if (!current || !current.element.isConnected) {
        const hit = findTourTarget(request.targets);
        if (hit) {
          current = { ...hit, rect: hit.element.getBoundingClientRect() };
          setFound(current);
        } else if (current || performance.now() - started > SPOTLIGHT_WAIT_MS) {
          close(); // never appeared, or went away
          return;
        }
      } else {
        const rect = current.element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          close();
          return;
        }
        const prev = current.rect;
        if (rect.top !== prev.top || rect.left !== prev.left || rect.width !== prev.width || rect.height !== prev.height) {
          current = { ...current, rect };
          setFound(current);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [request, close]);

  // Using the control, Escape, or the drawer closing ends it.
  useEffect(() => {
    if (!found) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && found.element.contains(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [found, close]);

  useEffect(() => {
    if (found && isMobile && !drawerOpen) close();
  }, [found, isMobile, drawerOpen, close]);

  if (!request || !found) return null;

  const { rect } = found;
  const hole = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fitsRight = hole.left + hole.width + CAPTION_GAP + CAPTION_WIDTH <= vw - 8;
  const caption = fitsRight
    ? { top: Math.max(8, Math.min(hole.top, vh - 120)), left: hole.left + hole.width + CAPTION_GAP }
    : {
        top: hole.top + hole.height + CAPTION_GAP + 80 < vh ? hole.top + hole.height + CAPTION_GAP : Math.max(8, hole.top - CAPTION_GAP - 80),
        left: Math.max(8, Math.min(hole.left, vw - CAPTION_WIDTH - 8)),
      };
  const preferred = request.targets[0];

  return createPortal(
    <div className="guide-spot" role="dialog" aria-live="polite">
      <div className="guide-spot-dim" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} onPointerDown={close} />
      <div className="guide-spot-dim" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} onPointerDown={close} />
      <div className="guide-spot-ring" style={hole} />
      <div className="guide-spot-caption" style={caption}>
        {t(tourCaptionKey(request.step, preferred, found.target))}
      </div>
    </div>,
    document.body,
  );
}

export default GuideSpotlight;
