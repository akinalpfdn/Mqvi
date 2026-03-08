/** LinkPreviewCard — Open Graph preview card for URLs in messages. Session-cached. */

import { useState, useEffect } from "react";
import { getLinkPreview } from "../../api/linkPreview";
import type { LinkPreview } from "../../types";

/** Session-level cache — cleared on page reload */
const previewCache = new Map<string, LinkPreview | null>();

/** Deduplicates concurrent fetches for the same URL */
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
    // Skip fetch if cached
    if (previewCache.has(url)) {
      setPreview(previewCache.get(url) ?? null);
      setLoaded(true);
      return;
    }

    let cancelled = false;

    async function load() {
      // Deduplicate: reuse pending fetch for same URL
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

  // Show nothing until loaded
  if (!loaded || !preview) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="link-preview"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Left accent bar */}
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
