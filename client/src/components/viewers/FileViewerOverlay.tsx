/**
 * FileViewerOverlay — in-app viewer for images, video, audio, PDF, DOCX, XLSX.
 * Dispatches by MIME type. Heavy parsers (mammoth, xlsx, react-pdf) are
 * dynamic-imported so plain chat sessions never load them.
 *
 * Size guard: docs and PDFs above PREVIEW_SIZE_LIMIT skip preview and show
 * a Download fallback to avoid hanging the browser on large parses.
 *
 * Object URL ownership: the overlay never allocates URLs for the source.
 * The caller owns the lifecycle (EncryptedAttachment keeps blob URLs alive
 * while it is mounted; plaintext callers pass plain asset URLs).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchContentRef } from "react-zoom-pan-pinch";
import DOMPurify from "dompurify";
import { useFileViewerStore, type FileViewerItem } from "../../stores/fileViewerStore";
import { isInlineVideo, isVideoFile } from "../../utils/inlineMedia";
import { useToastStore } from "../../stores/toastStore";
import { useIsTouch } from "../../hooks/useMediaQuery";
import { useBackHandler } from "../../hooks/useBackHandler";
import { formatBytes } from "../../utils/formatBytes";

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

// Copies an image URL to the clipboard as PNG (the only format browsers
// reliably accept). Decodes via canvas so JPEG/WebP/GIF all work.
async function copyImageToClipboard(src: string): Promise<boolean> {
  try {
    const blob = await fetch(src).then((r) => r.blob());
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) return false;

    // Electron's renderer clipboard API is sandboxed and silently fails for images
    // (text is routed through main for the same reason) — write PNG bytes natively
    // via IPC. Browser builds fall back to the async clipboard API.
    if (window.electronAPI?.writeClipboardImage) {
      await window.electronAPI.writeClipboardImage(new Uint8Array(await png.arrayBuffer()));
    } else {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    }
    return true;
  } catch (err) {
    console.error("[FileViewer] copy image failed:", err);
    return false;
  }
}

const PREVIEW_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB

// <style> tags are intentionally stripped (CSS rules are unscoped and would
// leak to the rest of the app); inline `style` attributes carry mammoth's
// per-element formatting.
function sanitizeHtml(input: string): string {
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: [
      "a", "abbr", "b", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
      "hr", "i", "img", "li", "ol", "p", "pre", "span", "strong", "sub", "sup",
      "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "colspan", "rowspan", "class", "style"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/[a-z+]+;base64,)/i,
  }) as unknown as string;
}

/** Unknown size reads as an em dash rather than "0 B", which would be a claim we cannot make. */
function formatSize(bytes: number | null): string {
  if (bytes == null || bytes === 0) return "—";
  return formatBytes(bytes);
}

function classifyMime(mime: string, filename: string): "image" | "video" | "audio" | "pdf" | "docx" | "xlsx" | "other" {
  const m = (mime || "").toLowerCase();
  const name = (filename || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  // Extension, not the declared type, and only the containers the serve layer hands back inline —
  // the thumbnail already refuses to promise a .mkv is playable, and opening it must not put a
  // full-screen player in front of a file the browser will never render.
  if (m.startsWith("video/") || isVideoFile(name)) {
    return isInlineVideo(name) ? "video" : "other";
  }
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) return "docx";
  if (
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    name.endsWith(".xlsx") ||
    name.endsWith(".xlsm")
  ) return "xlsx";
  return "other";
}

function FileViewerOverlay() {
  const item = useFileViewerStore((s) => s.item);
  const close = useFileViewerStore((s) => s.close);
  const location = useLocation();

  // Escape to close + body scroll lock while open.
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [item, close]);

  // Auto-close on route change. E2EE attachments revoke their blob URL when
  // their parent message unmounts (channel switch), which would leave the
  // overlay with a dangling src. Closing on navigation avoids that and matches
  // user expectation that "leaving the screen" hides the viewer.
  useEffect(() => {
    if (item) close();
    // We intentionally only react to pathname changes, not to `item` toggling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (!item) return null;
  return createPortal(<OverlayShell item={item} onClose={close} />, document.body);
}

type ShellProps = { item: FileViewerItem; onClose: () => void };

function OverlayShell({ item, onClose }: ShellProps) {
  const { t } = useTranslation("viewer");
  const addToast = useToastStore((s) => s.addToast);
  const isTouch = useIsTouch();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const kind = classifyMime(item.mime, item.filename);

  async function handleCopyImage() {
    const ok = await copyImageToClipboard(item.src);
    addToast(ok ? "success" : "error", ok ? t("copied") : t("copyFailed"));
  }
  const downloadHref = item.downloadHref ?? item.src;
  const tooLargeForPreview =
    (kind === "pdf" || kind === "docx" || kind === "xlsx") &&
    item.size != null &&
    item.size > PREVIEW_SIZE_LIMIT;

  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    // Touch never closes on a tap — closing on tap leaks the synthesized click through to the
    // message behind the overlay once it unmounts (reopening it). Touch closes via swipe / back /
    // the close button. Desktop keeps click-outside-to-close.
    if (isTouch) return;
    if (e.button !== 0) return;
    if (e.target === e.currentTarget) onClose();
  }

  // Android back / gesture closes the viewer only, without navigating the app's route.
  useBackHandler(onClose);

  // Focus trap + initial focus + restore on close.
  // Tab/Shift+Tab cycle through focusable elements inside the overlay; focus
  // never escapes to elements behind the modal.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // On touch, restoring focus to the composer on close reopens the soft keyboard — so watching
    // a video flaps the keyboard on every open/close. Blur it on open (keyboard closes cleanly)
    // and skip the restore on close. Desktop keeps focus restore for keyboard navigation.
    const restoreFocus = !(isTouch && isTextEntry(previouslyFocused));
    if (!restoreFocus) previouslyFocused?.blur?.();
    // Defer initial focus to next frame so the close button is mounted.
    const id = requestAnimationFrame(() => closeBtnRef.current?.focus());

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", onKey);
      if (restoreFocus) previouslyFocused?.focus?.();
    };
  }, [isTouch]);

  let body: ReactNode;
  if (tooLargeForPreview) {
    body = (
      <FallbackPanel
        message={t("previewTooLarge", { size: formatSize(item.size) })}
        downloadHref={downloadHref}
        downloadName={item.filename}
      />
    );
  } else if (kind === "image") {
    body = <ImageViewer src={item.src} filename={item.filename} onClose={onClose} isTouch={isTouch} />;
  } else if (kind === "video") {
    body = <VideoViewer src={item.src} />;
  } else if (kind === "audio") {
    body = <AudioViewer src={item.src} filename={item.filename} />;
  } else if (kind === "pdf") {
    body = <PdfViewer src={item.src} />;
  } else if (kind === "docx") {
    body = <DocxViewer src={item.src} />;
  } else if (kind === "xlsx") {
    body = <XlsxViewer src={item.src} />;
  } else {
    body = (
      <FallbackPanel
        message={t("previewUnsupported")}
        downloadHref={downloadHref}
        downloadName={item.filename}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="file-viewer-overlay"
      onClick={onBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={item.filename}
    >
      <div className="file-viewer-header">
        <div className="file-viewer-meta">
          <span className="file-viewer-filename" title={item.filename}>{item.filename}</span>
          <span className="file-viewer-size">{formatSize(item.size)}</span>
        </div>
        <div className="file-viewer-actions">
          {kind === "image" && (
            <button className="file-viewer-btn" onClick={handleCopyImage}>
              {t("copy")}
            </button>
          )}
          <a
            href={downloadHref}
            download={item.filename}
            className="file-viewer-btn"
            aria-label={t("download")}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("download")}
          </a>
          <button
            ref={closeBtnRef}
            className="file-viewer-btn file-viewer-close"
            onClick={onClose}
            aria-label={t("close")}
          >
            &#x2715;
          </button>
        </div>
      </div>
      <div className="file-viewer-body" onClick={onBackdropClick}>{body}</div>
    </div>
  );
}

// ─── Per-type viewers ───

function ImageViewer({ src, filename, onClose, isTouch }: { src: string; filename: string; onClose: () => void; isTouch: boolean }) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const transformRef = useRef<ReactZoomPanPinchContentRef | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLElement | null>(null);
  const pointersRef = useRef(0);
  const draggingRef = useRef(false);
  const DISMISS_PX = 110;

  // Drag-to-dismiss: at scale 1, a one-finger vertical drag moves the image with the finger while
  // the backdrop fades; releasing past the threshold flings it off-screen and closes, shorter drags
  // snap back. Zoomed in (scale > 1) or with a second finger down, it yields to react-zoom-pan-pinch.
  function paint(dy: number) {
    if (outerRef.current) {
      outerRef.current.style.transition = "";
      const shrink = Math.max(0.9, 1 - Math.abs(dy) / 1600);
      outerRef.current.style.transform = `translateY(${dy}px) scale(${shrink})`;
    }
    if (overlayRef.current) {
      overlayRef.current.style.transition = "";
      overlayRef.current.style.opacity = String(Math.max(0.3, 1 - Math.abs(dy) / 500));
    }
  }
  function snapBack() {
    if (outerRef.current) {
      outerRef.current.style.transition = "transform 0.22s ease";
      outerRef.current.style.transform = "";
    }
    if (overlayRef.current) {
      overlayRef.current.style.transition = "opacity 0.22s ease";
      overlayRef.current.style.opacity = "";
    }
  }
  function fling(dir: number) {
    if (outerRef.current) {
      outerRef.current.style.transition = "transform 0.2s ease";
      outerRef.current.style.transform = `translateY(${dir * window.innerHeight}px)`;
    }
    if (overlayRef.current) {
      overlayRef.current.style.transition = "opacity 0.2s ease";
      overlayRef.current.style.opacity = "0";
    }
    window.setTimeout(onClose, 190);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current += 1;
    if (pointersRef.current === 1) {
      startRef.current = { x: e.clientX, y: e.clientY };
      overlayRef.current = outerRef.current?.closest(".file-viewer-overlay") as HTMLElement | null;
      draggingRef.current = false;
    } else {
      // Second finger — a pinch. Abandon any dismiss drag in progress.
      if (draggingRef.current) snapBack();
      draggingRef.current = false;
      startRef.current = null;
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isTouch || pointersRef.current !== 1) return;
    const start = startRef.current;
    if (!start) return;
    if ((transformRef.current?.state.scale ?? 1) > 1.05) return; // zoomed → let the library pan
    const dy = e.clientY - start.y;
    const dx = e.clientX - start.x;
    if (!draggingRef.current) {
      // Only engage once the gesture is clearly a vertical drag.
      if (Math.abs(dy) < 12 || Math.abs(dy) <= Math.abs(dx)) return;
      draggingRef.current = true;
    }
    paint(dy);
  }
  function onPointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current = Math.max(0, pointersRef.current - 1);
    const start = startRef.current;
    const wasDragging = draggingRef.current;
    if (pointersRef.current === 0) {
      startRef.current = null;
      draggingRef.current = false;
    }
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    if (isTouch) {
      if (wasDragging) {
        if (Math.abs(dy) > DISMISS_PX) fling(dy > 0 ? 1 : -1);
        else snapBack();
      }
      // A plain tap (no drag) does nothing.
      return;
    }
    // Desktop: a click outside the image (not a drag, not on the IMG) closes.
    if (e.button === 0 && Math.hypot(dx, dy) < 5 && (e.target as HTMLElement).tagName !== "IMG") {
      onClose();
    }
  }
  function onPointerCancel() {
    pointersRef.current = Math.max(0, pointersRef.current - 1);
    if (pointersRef.current === 0) {
      startRef.current = null;
      if (draggingRef.current) snapBack();
      draggingRef.current = false;
    }
  }

  return (
    <div
      ref={outerRef}
      className="file-viewer-image-outer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerCancel}
    >
      <TransformWrapper
        ref={transformRef}
        doubleClick={{ mode: "reset" }}
        minScale={1}
        maxScale={6}
        initialScale={1}
        centerOnInit
      >
        <TransformComponent
          wrapperClass="file-viewer-image-wrap"
          contentClass="file-viewer-image-content"
        >
          <img src={src} alt={filename} className="file-viewer-image" draggable={false} />
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}

function VideoViewer({ src }: { src: string }) {
  return <video className="file-viewer-video" controls autoPlay src={src} />;
}

function AudioViewer({ src, filename }: { src: string; filename: string }) {
  return (
    <div className="file-viewer-audio-wrap">
      <div className="file-viewer-audio-title">{filename}</div>
      <audio className="file-viewer-audio" controls autoPlay src={src} />
    </div>
  );
}

function PdfViewer({ src }: { src: string }) {
  const { t } = useTranslation("viewer");
  const [Lib, setLib] = useState<null | typeof import("react-pdf")>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const mod = await import("react-pdf");
        // pdf.js worker — Vite will resolve and emit a hashed file.
        const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
        mod.pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        if (mounted) setLib(mod);
      } catch (err) {
        console.error("[FileViewer] PDF lib load failed", err);
        if (mounted) setError(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (error) return <FallbackMessage message={t("previewFailed")} />;
  if (!Lib) return <FallbackMessage message={t("loading")} />;

  const { Document, Page } = Lib;
  return (
    <div className="file-viewer-pdf">
      <Document
        file={src}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        onLoadError={() => setError(true)}
        loading={<FallbackMessage message={t("loading")} />}
        error={<FallbackMessage message={t("previewFailed")} />}
      >
        {numPages
          ? Array.from({ length: numPages }, (_, i) => (
              <Page key={i + 1} pageNumber={i + 1} renderAnnotationLayer={false} renderTextLayer={false} />
            ))
          : null}
      </Document>
    </div>
  );
}

function DocxViewer({ src }: { src: string }) {
  const { t } = useTranslation("viewer");
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [{ default: mammoth }, buf] = await Promise.all([
          import("mammoth"),
          fetch(src).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
        ]);
        const result = await mammoth.convertToHtml({ arrayBuffer: buf });
        if (mounted) setHtml(sanitizeHtml(result.value));
      } catch (err) {
        console.error("[FileViewer] DOCX render failed", err);
        if (mounted) setError(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [src]);

  if (error) return <FallbackMessage message={t("previewFailed")} />;
  if (html == null) return <FallbackMessage message={t("loading")} />;
  // html has already been DOMPurify-sanitized in the effect above.
  return <div className="file-viewer-docx" dangerouslySetInnerHTML={{ __html: html }} />;
}

function XlsxViewer({ src }: { src: string }) {
  const { t } = useTranslation("viewer");
  type Sheet = { name: string; html: string };
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [XLSX, buf] = await Promise.all([
          import("xlsx"),
          fetch(src).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
        ]);
        const wb = XLSX.read(buf, { type: "array" });
        const out: Sheet[] = wb.SheetNames.map((name) => ({
          name,
          html: sanitizeHtml(XLSX.utils.sheet_to_html(wb.Sheets[name], { id: "" })),
        }));
        if (mounted) setSheets(out);
      } catch (err) {
        console.error("[FileViewer] XLSX render failed", err);
        if (mounted) setError(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [src]);

  if (error) return <FallbackMessage message={t("previewFailed")} />;
  if (!sheets) return <FallbackMessage message={t("loading")} />;
  if (sheets.length === 0) return <FallbackMessage message={t("previewUnsupported")} />;

  const sheet = sheets[active] ?? sheets[0];
  return (
    <div className="file-viewer-xlsx">
      {sheets.length > 1 && (
        <div className="file-viewer-xlsx-tabs" role="tablist">
          {sheets.map((s, idx) => (
            <button
              key={s.name + idx}
              role="tab"
              aria-selected={idx === active}
              className={`file-viewer-xlsx-tab${idx === active ? " active" : ""}`}
              onClick={() => setActive(idx)}
            >
              {s.name || `${t("sheet")} ${idx + 1}`}
            </button>
          ))}
        </div>
      )}
      <div
        className="file-viewer-xlsx-sheet"
        // sheet.html has been DOMPurify-sanitized at parse time.
        dangerouslySetInnerHTML={{ __html: sheet.html }}
      />
    </div>
  );
}

// ─── Shared helpers ───

function FallbackMessage({ message }: { message: string }) {
  return <div className="file-viewer-fallback-msg">{message}</div>;
}

function FallbackPanel({
  message,
  downloadHref,
  downloadName,
}: {
  message: string;
  downloadHref: string;
  downloadName: string;
}) {
  const { t } = useTranslation("viewer");
  return (
    <div className="file-viewer-fallback-panel">
      <div className="file-viewer-fallback-msg">{message}</div>
      <a
        href={downloadHref}
        download={downloadName}
        className="file-viewer-btn file-viewer-fallback-download"
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("download")}
      </a>
    </div>
  );
}

export default FileViewerOverlay;
