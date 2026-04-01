/**
 * WaveformTrimmer — Canvas-based audio waveform with draggable start/end handles.
 * Decodes audio via Web Audio API, renders amplitude bars, enforces max duration.
 */

import { useEffect, useRef, useState, useCallback } from "react";
type Props = {
  fileUrl: string;
  totalDurationMs: number;
  maxDurationMs: number;
  trimStart: number;
  trimEnd: number;
  onTrimChange: (start: number, end: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
};

const CANVAS_HEIGHT = 64;
const BAR_WIDTH = 2;
const BAR_GAP = 1;
const HANDLE_WIDTH = 8;

function WaveformTrimmer({
  fileUrl,
  totalDurationMs,
  maxDurationMs,
  trimStart,
  trimEnd,
  onTrimChange,
  isPlaying,
  onTogglePlay,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<number[]>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const draggingRef = useRef<"start" | "end" | "region" | null>(null);
  const dragOffsetRef = useRef(0);

  // Decode audio and compute peaks
  useEffect(() => {
    const ctx = new AudioContext();
    fetch(fileUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => ctx.decodeAudioData(buf))
      .then((audioBuffer) => {
        const data = audioBuffer.getChannelData(0);
        const barCount = Math.floor(containerWidth / (BAR_WIDTH + BAR_GAP)) || 100;
        const blockSize = Math.floor(data.length / barCount);
        const peaks: number[] = [];
        for (let i = 0; i < barCount; i++) {
          let sum = 0;
          const start = i * blockSize;
          for (let j = start; j < start + blockSize && j < data.length; j++) {
            sum += Math.abs(data[j]);
          }
          peaks.push(sum / blockSize);
        }
        // Normalize
        const max = Math.max(...peaks, 0.01);
        peaksRef.current = peaks.map((p) => p / max);
        drawWaveform();
        ctx.close();
      })
      .catch(() => {
        ctx.close();
      });
  }, [fileUrl, containerWidth]);

  // Observe container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Redraw on trim change
  useEffect(() => {
    drawWaveform();
  }, [trimStart, trimEnd, containerWidth]);

  const msToX = useCallback(
    (ms: number) => (ms / totalDurationMs) * containerWidth,
    [totalDurationMs, containerWidth]
  );
  const xToMs = useCallback(
    (x: number) => Math.round((x / containerWidth) * totalDurationMs),
    [totalDurationMs, containerWidth]
  );

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerWidth === 0) return;

    canvas.width = containerWidth;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const peaks = peaksRef.current;
    if (peaks.length === 0) return;

    const startX = msToX(trimStart);
    const endX = msToX(trimEnd);

    ctx.clearRect(0, 0, containerWidth, CANVAS_HEIGHT);

    // Draw bars
    const step = BAR_WIDTH + BAR_GAP;
    for (let i = 0; i < peaks.length; i++) {
      const x = i * step;
      const h = Math.max(2, peaks[i] * (CANVAS_HEIGHT - 8));
      const y = (CANVAS_HEIGHT - h) / 2;

      const inRegion = x >= startX && x <= endX;
      const accentColor = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#7c5cfc";
      ctx.fillStyle = inRegion ? accentColor : "rgba(255,255,255,0.15)";
      ctx.fillRect(x, y, BAR_WIDTH, h);
    }

    // Dimmed regions outside trim
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(0, 0, startX, CANVAS_HEIGHT);
    ctx.fillRect(endX, 0, containerWidth - endX, CANVAS_HEIGHT);

    // Handles
    drawHandle(ctx, startX, "#fff");
    drawHandle(ctx, endX, "#fff");
  }, [containerWidth, trimStart, trimEnd, msToX]);

  function drawHandle(ctx: CanvasRenderingContext2D, x: number, color: string) {
    ctx.fillStyle = color;
    ctx.fillRect(x - HANDLE_WIDTH / 2, 0, HANDLE_WIDTH, CANVAS_HEIGHT);
    // Grip lines
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(x - 1, 8, 1, CANVAS_HEIGHT - 16);
    ctx.fillRect(x + 1, 8, 1, CANVAS_HEIGHT - 16);
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const startX = msToX(trimStart);
    const endX = msToX(trimEnd);

    // Check if near handles (within 12px)
    if (Math.abs(x - startX) < 12) {
      draggingRef.current = "start";
    } else if (Math.abs(x - endX) < 12) {
      draggingRef.current = "end";
    } else if (x > startX && x < endX) {
      draggingRef.current = "region";
      dragOffsetRef.current = x - startX;
    } else {
      return;
    }

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = Math.max(0, Math.min(e.clientX - rect.left, containerWidth));
    const ms = xToMs(x);

    if (draggingRef.current === "start") {
      const newStart = Math.max(0, Math.min(ms, trimEnd - 200));
      // Enforce max duration
      if (trimEnd - newStart > maxDurationMs) {
        onTrimChange(trimEnd - maxDurationMs, trimEnd);
      } else {
        onTrimChange(newStart, trimEnd);
      }
    } else if (draggingRef.current === "end") {
      const newEnd = Math.min(totalDurationMs, Math.max(ms, trimStart + 200));
      if (newEnd - trimStart > maxDurationMs) {
        onTrimChange(trimStart, trimStart + maxDurationMs);
      } else {
        onTrimChange(trimStart, newEnd);
      }
    } else if (draggingRef.current === "region") {
      const regionLen = trimEnd - trimStart;
      let newStart = xToMs(x - dragOffsetRef.current);
      newStart = Math.max(0, Math.min(newStart, totalDurationMs - regionLen));
      onTrimChange(newStart, newStart + regionLen);
    }
  };

  const handlePointerUp = () => {
    draggingRef.current = null;
  };

  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const trimmedMs = trimEnd - trimStart;

  return (
    <div className="wt-container">
      <div className="wt-top-row">
        <button className="wt-play-btn" onClick={onTogglePlay}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            {isPlaying ? (
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            ) : (
              <path d="M8 5v14l11-7z" />
            )}
          </svg>
        </button>
        <span className="wt-time">{fmt(trimStart)}</span>
        <span className="wt-dash">—</span>
        <span className="wt-time">{fmt(trimEnd)}</span>
        <span className={`wt-dur${trimmedMs > maxDurationMs ? " error" : ""}`}>
          ({fmt(trimmedMs)})
        </span>
      </div>
      <div
        ref={containerRef}
        className="wt-canvas-wrap"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <canvas ref={canvasRef} height={CANVAS_HEIGHT} />
      </div>
    </div>
  );
}

export default WaveformTrimmer;
