/**
 * DMSearchPanel — DM mesaj arama paneli.
 *
 * Channel SearchPanel ile aynı pattern:
 * - FTS5 tam metin arama + pagination (limit/offset/total_count)
 * - Sonuçlara tıklayınca scrollToMessageId ile mesaja scroll
 * - Önceki/Sonraki sayfa navigasyonu
 *
 * CSS class'ları: SearchPanel ile aynı — .search-panel, .search-header, vb.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import Avatar from "../shared/Avatar";
import type { DMMessage } from "../../types";

/** Debounce süresi (ms) */
const DEBOUNCE_MS = 300;

/** Sayfa başına sonuç limiti */
const LIMIT = 25;

type DMSearchPanelProps = {
  channelId: string;
  onClose: () => void;
};

type SearchState = {
  messages: DMMessage[];
  totalCount: number;
} | null;

function DMSearchPanel({ channelId, onClose }: DMSearchPanelProps) {
  const { t } = useTranslation("chat");
  const searchMessages = useDMStore((s) => s.searchMessages);
  const setScrollToMessageId = useDMStore((s) => s.setScrollToMessageId);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchState>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(
    async (searchQuery: string, searchOffset: number) => {
      if (searchQuery.trim().length < 1) {
        setResults(null);
        return;
      }

      setIsSearching(true);
      const result = await searchMessages(channelId, searchQuery.trim(), LIMIT, searchOffset);
      setResults({
        messages: result.messages,
        totalCount: result.total_count,
      });
      setIsSearching(false);
    },
    [channelId, searchMessages]
  );

  /** Input değiştiğinde debounce ile arama */
  function handleInputChange(value: string) {
    setQuery(value);
    setOffset(0);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      doSearch(value, 0);
    }, DEBOUNCE_MS);
  }

  /** Sonraki sayfa */
  function handleNextPage() {
    const newOffset = offset + LIMIT;
    setOffset(newOffset);
    doSearch(query, newOffset);
  }

  /** Önceki sayfa */
  function handlePrevPage() {
    const newOffset = Math.max(0, offset - LIMIT);
    setOffset(newOffset);
    doSearch(query, newOffset);
  }

  /** Sonuca tıklanınca mesaja scroll */
  function handleSelectResult(msg: DMMessage) {
    setScrollToMessageId(msg.id);
    onClose();
  }

  /** Timestamp formatı */
  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString([], {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const totalPages = results ? Math.ceil(results.totalCount / LIMIT) : 0;
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="search-panel">
      {/* Header */}
      <div className="search-header">
        <span className="search-header-title">{t("searchMessages")}</span>
        <button onClick={onClose} className="search-close">
          <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Search input */}
      <div className="search-input-wrap">
        <svg className="search-input-icon" style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="search-input"
        />
      </div>

      {/* Results */}
      <div className="search-results">
        {isSearching ? (
          <p className="search-empty">{t("searching")}</p>
        ) : !results ? (
          <p className="search-empty">{t("searchHint")}</p>
        ) : results.messages.length === 0 ? (
          <p className="search-empty">{t("noSearchResults")}</p>
        ) : (
          <>
            <p className="search-count">
              {t("searchResultCount", { count: results.totalCount })}
            </p>
            {results.messages.map((msg) => {
              const displayName = msg.author?.display_name ?? msg.author?.username ?? "Unknown";

              return (
                <div
                  key={msg.id}
                  className="search-result-item"
                  onClick={() => handleSelectResult(msg)}
                >
                  <div className="search-result-header">
                    <Avatar
                      name={displayName}
                      avatarUrl={msg.author?.avatar_url ?? undefined}
                      size={18}
                    />
                    <span className="search-result-author">{displayName}</span>
                    <span className="search-result-time">{formatDate(msg.created_at)}</span>
                  </div>
                  <div className="search-result-content">
                    {msg.content ?? ""}
                  </div>
                </div>
              );
            })}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="search-pagination">
                <button
                  onClick={handlePrevPage}
                  disabled={currentPage <= 1}
                  className="search-page-btn"
                >
                  {t("searchPrev")}
                </button>
                <span className="search-page-info">
                  {currentPage} / {totalPages}
                </span>
                <button
                  onClick={handleNextPage}
                  disabled={currentPage >= totalPages}
                  className="search-page-btn"
                >
                  {t("searchNext")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default DMSearchPanel;
