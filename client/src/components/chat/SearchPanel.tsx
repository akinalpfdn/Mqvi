/**
 * SearchPanel — Mesaj arama paneli.
 *
 * CSS class'ları: .search-panel, .search-header, .search-input-wrap,
 * .search-input, .search-results, .search-result-item, .search-empty,
 * .search-pagination
 *
 * Kanal header'ındaki arama ikonuna tıklayınca açılır.
 * Debounce ile arama — 300ms bekleme süresi sonra API çağrısı yapar.
 * Sonuçlara tıklamak kanala yönlendirir (ileride implementasyon).
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { searchMessages } from "../../api/search";
import type { SearchResult } from "../../api/search";
import type { Message } from "../../types";
import Avatar from "../shared/Avatar";

/** Debounce süresi (ms) — kullanıcı yazmayı bırakınca bu süre sonra arama yapar */
const DEBOUNCE_MS = 300;

type SearchPanelProps = {
  channelId?: string;
  onClose: () => void;
  /** Sonuca tıklanınca mesajın kanalına git */
  onSelectResult?: (message: Message) => void;
};

function SearchPanel({ channelId, onClose, onSelectResult }: SearchPanelProps) {
  const { t } = useTranslation("chat");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const limit = 25;

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
      const res = await searchMessages(searchQuery.trim(), channelId, limit, searchOffset);
      if (res.success && res.data) {
        setResults(res.data);
      } else {
        setResults({ messages: [], total_count: 0 });
      }
      setIsSearching(false);
    },
    [channelId]
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
    const newOffset = offset + limit;
    setOffset(newOffset);
    doSearch(query, newOffset);
  }

  /** Önceki sayfa */
  function handlePrevPage() {
    const newOffset = Math.max(0, offset - limit);
    setOffset(newOffset);
    doSearch(query, newOffset);
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

  const totalPages = results ? Math.ceil(results.total_count / limit) : 0;
  const currentPage = Math.floor(offset / limit) + 1;

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
              {t("searchResultCount", { count: results.total_count })}
            </p>
            {results.messages.map((msg) => {
              const displayName = msg.author?.display_name ?? msg.author?.username ?? "Unknown";

              return (
                <div
                  key={msg.id}
                  className="search-result-item"
                  onClick={() => onSelectResult?.(msg)}
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

export default SearchPanel;
