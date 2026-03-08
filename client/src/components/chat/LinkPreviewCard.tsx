/**
 * LinkPreviewCard — Mesaj içindeki URL'ler için Open Graph preview kartı.
 *
 * Mount'ta backend /api/link-preview endpoint'inden OG metadata çekilir.
 * Gösterilen bilgiler: site name, favicon, title, description, OG image.
 *
 * Client-side session cache: Aynı URL tekrar fetch edilmez (Map<string, LinkPreview>).
 *
 * CSS class'ları: .link-preview, .link-preview-accent, .link-preview-body,
 * .link-preview-site, .link-preview-title, .link-preview-desc,
 * .link-preview-img, .link-preview-favicon
 */

import { useState, useEffect } from "react";
import { getLinkPreview } from "../../api/linkPreview";
import type { LinkPreview } from "../../types";

/** Client-side session cache — sunucu restart'ında temizlenir */
const previewCache = new Map<string, LinkPreview | null>();

/** Aynı URL için birden fazla concurrent fetch engelleme */
const pendingFetches = new Map<string, Promise<LinkPreview | null>>();

type LinkPreviewCardProps = {
  url: string;
};

function LinkPreviewCard({ url }: LinkPreviewCardProps) {
  const [preview, setPreview] = useState<LinkPreview | null>(
    previewCache.get(url) ?? null
  );
  const [loaded, setLoaded] = useState(previewCache.has(url));

  useEffect(() => {
    // Cache'te varsa tekrar fetch etme
    if (previewCache.has(url)) {
      setPreview(previewCache.get(url) ?? null);
      setLoaded(true);
      return;
    }

    let cancelled = false;

    async function load() {
      // Deduplicate: aynı URL için zaten fetch varsa bekle
      let fetchPromise = pendingFetches.get(url);
      if (!fetchPromise) {
        fetchPromise = (async () => {
          const res = await getLinkPreview(url);
          const data = res.success && res.data ? res.data : null;
          previewCache.set(url, data);
          pendingFetches.delete(url);
          return data;
        })();
        pendingFetches.set(url, fetchPromise);
      }

      const data = await fetchPromise;
      if (!cancelled) {
        setPreview(data);
        setLoaded(true);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [url]);

  // Yüklenene kadar hiçbir şey gösterme (skeleton gereksiz — asenkron yüklenir)
  if (!loaded || !preview) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="link-preview"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Sol accent bar */}
      <span className="link-preview-accent" />

      <span className="link-preview-body">
        {/* Site name + favicon */}
        {preview.site_name && (
          <span className="link-preview-site">
            {preview.favicon_url && (
              <img
                src={preview.favicon_url}
                alt=""
                className="link-preview-favicon"
                loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            )}
            {preview.site_name}
          </span>
        )}

        {/* Title */}
        {preview.title && (
          <span className="link-preview-title">{preview.title}</span>
        )}

        {/* Description */}
        {preview.description && (
          <span className="link-preview-desc">{preview.description}</span>
        )}

        {/* OG Image */}
        {preview.image_url && (
          <img
            src={preview.image_url}
            alt={preview.title ?? ""}
            className="link-preview-img"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        )}
      </span>
    </a>
  );
}

export default LinkPreviewCard;
