/**
 * FeatureGuide — the help center body: collapsible category nav beside a markdown article
 * pane, drilling down to one column at a time on a phone. Manifest-driven; titles from the
 * "help" i18n namespace, bodies lazy-loaded per language with English fallback.
 * Shared by the InfoModal Features tab (and, later, a landing /features route).
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useBackHandler } from "../../hooks/useBackHandler";
import { HELP_CATEGORIES, type HelpIcon } from "./manifest";
import { loadArticleBody, loadAllBodies, resolveAsset, type LoadedArticle } from "./loader";

const VIDEO_EXT = /\.(webm|mp4)$/i;

/** Resolves bundled help media; renders <video> for clips, <img> otherwise. */
function HelpMedia({ src, alt }: { src?: string; alt?: string }) {
  const url = resolveAsset(src);
  if (!url) return <span className="fg-img-missing">🖼 {alt || src}</span>;
  if (VIDEO_EXT.test(src || "")) {
    return <video className="fg-media" src={url} autoPlay loop muted playsInline />;
  }
  return <img className="fg-media" src={url} alt={alt || ""} loading="lazy" />;
}

const ICON_PATHS: Record<HelpIcon, string> = {
  rocket: "M15.59 14.37a6 6 0 01-5.84 7.38v-4.82m5.84-2.56a14.95 14.95 0 005.84-2.56 14.95 14.95 0 00-2.56-8.4 14.95 14.95 0 00-8.4-2.56 14.95 14.95 0 00-2.56 5.84m7.72 10.24L8.06 9.66m1.69 7.27a6 6 0 00-4.18-4.18",
  chat: "M8 12h.01M12 12h.01M16 12h.01M21 12a9 9 0 01-9 9 9.75 9.75 0 01-3.9-.81L3 21l1.11-3.32A9 9 0 1121 12z",
  voice: "M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V6a3 3 0 116 0v6.75a3 3 0 01-3 3z",
  friends: "M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z",
  servers: "M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z",
  roles: "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z",
  lock: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z",
  user: "M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z",
  sliders: "M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75",
  server: "M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7",
  sparkle: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z",
};

function HelpIconSvg({ icon }: { icon: HelpIcon }) {
  return (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d={ICON_PATHS[icon]} />
    </svg>
  );
}

const FIRST_CAT = HELP_CATEGORIES.find((c) => c.articles.length > 0);
const ALL_ARTICLES = HELP_CATEGORIES.flatMap((c) => c.articles);
const ALL_SLUGS = ALL_ARTICLES.map((a) => a.slug);

function FeatureGuide() {
  const { t, i18n } = useTranslation("help");
  const { t: tCommon } = useTranslation("common");
  const lang = (i18n.language || "en").split("-")[0];
  const isMobile = useIsMobile();

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(FIRST_CAT ? [FIRST_CAT.id] : []),
  );
  const [selected, setSelected] = useState<string | null>(FIRST_CAT?.articles[0]?.slug ?? null);

  // A phone has no room for a table of contents beside the article, so it drills in instead:
  // the list fills the screen, tapping an entry swaps it for the article.
  const [articleOpen, setArticleOpen] = useState(false);
  useBackHandler(() => setArticleOpen(false), isMobile && articleOpen);

  function openArticle(slug: string) {
    setSelected(slug);
    setArticleOpen(true);
  }
  const [article, setArticle] = useState<LoadedArticle | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  // Load the selected article's body whenever the slug or language changes.
  useEffect(() => {
    if (!selected) {
      setArticle(null);
      return;
    }
    const id = ++reqRef.current;
    setLoading(true);
    loadArticleBody(lang, selected).then((loaded) => {
      if (reqRef.current !== id) return; // a newer selection won
      setArticle(loaded);
      setLoading(false);
    });
  }, [selected, lang]);

  const toggleCategory = (catId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });

  // ─── Search ───
  const [query, setQuery] = useState("");
  const [bodies, setBodies] = useState<Map<string, string> | null>(null);
  const q = query.trim().toLowerCase();

  // Re-index when the language changes (search the active language's bodies).
  useEffect(() => setBodies(null), [lang]);

  // Load every article body on the first search (cached thereafter).
  useEffect(() => {
    if (q && !bodies) loadAllBodies(lang, ALL_SLUGS).then(setBodies);
  }, [q, bodies, lang]);

  const results = q
    ? ALL_ARTICLES.filter((a) => {
        if (t(a.titleKey).toLowerCase().includes(q)) return true;
        const body = bodies?.get(a.slug);
        return body ? body.toLowerCase().includes(q) : false;
      })
    : [];

  const showNav = !isMobile || !articleOpen;
  const showContent = !isMobile || articleOpen;
  const selectedTitle = ALL_ARTICLES.find((a) => a.slug === selected)?.titleKey;

  return (
    <div className="feature-guide">
      {showNav && (
      <nav className="fg-nav">
        <input
          type="text"
          className="fg-search"
          placeholder={t("searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {q ? (
          <div className="fg-results">
            {results.length > 0 ? (
              results.map((a) => (
                <button
                  type="button"
                  key={a.slug}
                  className={`fg-article-link${selected === a.slug ? " active" : ""}`}
                  onClick={() => openArticle(a.slug)}
                >
                  {t(a.titleKey)}
                </button>
              ))
            ) : (
              <p className="fg-coming-soon">{bodies ? t("noResults") : "…"}</p>
            )}
          </div>
        ) : (
          HELP_CATEGORIES.map((cat) => {
          const open = expanded.has(cat.id);
          return (
            <div key={cat.id} className="fg-cat">
              <button
                type="button"
                className={`fg-cat-header${open ? " open" : ""}`}
                onClick={() => toggleCategory(cat.id)}
                aria-expanded={open}
              >
                <span className="fg-cat-icon"><HelpIconSvg icon={cat.icon} /></span>
                <span className="fg-cat-label">{t(cat.labelKey)}</span>
                <span className="fg-cat-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
              </button>
              {open && (
                <div className="fg-articles">
                  {cat.articles.length === 0 ? (
                    <p className="fg-coming-soon">{t("comingSoon")}</p>
                  ) : (
                    cat.articles.map((a) => (
                      <button
                        type="button"
                        key={a.slug}
                        className={`fg-article-link${selected === a.slug ? " active" : ""}`}
                        onClick={() => openArticle(a.slug)}
                      >
                        {t(a.titleKey)}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })
        )}
      </nav>
      )}

      {showContent && (
      <div className="fg-content">
        {isMobile && (
          <button type="button" className="fg-back" onClick={() => setArticleOpen(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>{selectedTitle ? t(selectedTitle) : tCommon("back")}</span>
          </button>
        )}
        {loading ? (
          <p className="fg-empty">…</p>
        ) : article ? (
          <>
            {!article.translated && <div className="fg-translate-note">{t("notTranslated")}</div>}
            <div className="fg-article-md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // Open external links in the browser, not in-app.
                  a: ({ node: _node, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer" />
                  ),
                  img: ({ node: _node, src, alt }) => <HelpMedia src={src as string} alt={alt} />,
                }}
              >
                {article.body}
              </ReactMarkdown>
            </div>
          </>
        ) : (
          <p className="fg-empty">{t("selectArticle")}</p>
        )}
      </div>
      )}
    </div>
  );
}

export default FeatureGuide;
